"""Flask application assembly; HTTP routes live in feature Blueprints."""
import hmac
import os
from urllib.parse import urlparse

from flask import Flask, g, jsonify, request

from app.planning.interpreter import AIError
from app.workshops.checkout import Checkout, CheckoutError
from app.bookings.service import CollabBooking
from app.shared.errors import BookingError
from app.expenses.ocr import ReceiptScanner, ReceiptScanError
from app.expenses.service import Expenses, ExpenseError
from app.groups.service import GroupError, Groups
from app.payments.paypal import PayPal, PayPalError
from app.groups.room import Room
from app.recommendations.rescue import PlanRescue
from app.recommendations.chat import ContextualAssistant
from app.recommendations.semantic import LocalEncoder
from app.recommendations.service import Recommendations
from app.shared.storage import Store, versions

from .config import database_url


def create_app(config=None, paypal=None, encoder=None):
    """Create the application without changing its existing HTTP contract."""
    app = Flask(__name__, static_folder=None)
    app.config.update(
        DATABASE_URL=database_url(),
        APP_ENV=os.getenv('APP_ENV', 'development'),
        APP_ORIGIN=os.getenv('APP_ORIGIN', 'http://localhost:8000').rstrip('/'),
        COOKIE_SECURE=os.getenv('COOKIE_SECURE', 'false').lower() == 'true',
        RECEIPT_VISION_PROVIDER=os.getenv('RECEIPT_VISION_PROVIDER', 'local_qwen'),
        OLLAMA_API_KEY=os.getenv('OLLAMA_API_KEY', ''),
        OLLAMA_VISION_MODEL=os.getenv('OLLAMA_VISION_MODEL', ''),
        MAX_CONTENT_LENGTH=16384,
    )
    if config:
        app.config.update(config)
    _validate_production_config(app)
    _register_dependencies(app, paypal, encoder)
    _register_http_guards(app)
    _register_error_handlers(app)
    _register_blueprints(app)
    return app


def _validate_production_config(app):
    if app.config['APP_ENV'] != 'production':
        return
    if not app.config['DATABASE_URL'].startswith(('postgres://', 'postgresql://', 'postgresql+psycopg://')):
        raise RuntimeError('Production requires durable managed PostgreSQL, not local SQLite')
    if not app.config['APP_ORIGIN'].startswith('https://') or not app.config['COOKIE_SECURE']:
        raise RuntimeError('Production requires HTTPS APP_ORIGIN and COOKIE_SECURE=true')


def _register_dependencies(app, paypal, encoder):
    store = Store(app.config['DATABASE_URL'])
    if app.config['APP_ENV'] != 'production':
        store.migrate(target=8)
        store.seed()
    else:
        from sqlalchemy import select
        with store.engine.connect() as connection:
            if connection.execute(select(versions.c.revision).where(versions.c.id == 1)).scalar() != 8:
                raise RuntimeError('Run python -m app migrate before starting')
    adapter = paypal or PayPal(
        os.getenv('PAYPAL_CLIENT_ID', ''), os.getenv('PAYPAL_CLIENT_SECRET', ''), os.getenv('PAYPAL_MERCHANT_ID', '')
    )
    checkout = Checkout(store, adapter)
    shared_encoder = encoder if encoder is not None else LocalEncoder(model='bge', query_instruction=True)
    booking = CollabBooking(store, app.config['APP_ORIGIN'], adapter)
    receipt_provider = app.config['RECEIPT_VISION_PROVIDER'].strip().lower()
    receipt_scanner = ReceiptScanner(
        provider=receipt_provider,
        ollama_api_key=app.config['OLLAMA_API_KEY'],
        ollama_model=app.config['OLLAMA_VISION_MODEL'],
    )
    app.extensions.update(
        store=store,
        checkout=checkout,
        groups=Groups(store, checkout, app.config['APP_ORIGIN']),
        paypal=adapter,
        booking=booking,
        room=Room(store),
        rescue=PlanRescue(store),
        recommendations=Recommendations(store, shared_encoder),
        assistant=ContextualAssistant(store, app.config['APP_ORIGIN'], shared_encoder),
        expenses=Expenses(store),
        receipt_scanner=receipt_scanner,
    )


def _register_http_guards(app):
    @app.before_request
    def authorize():
        if request.host != urlparse(app.config['APP_ORIGIN']).netloc:
            return jsonify(error='INVALID_HOST'), 400
        store = app.extensions['store']
        g.participant = store.participant(request.cookies.get('workshop_session'))
        if (request.path.startswith('/api/') and request.path != '/api/config') or request.path.startswith('/lessons/'):
            if not g.participant:
                return jsonify(error='PARTICIPANT_SESSION_REQUIRED'), 401
        if request.method == 'POST':
            if (request.headers.get('Origin') != app.config['APP_ORIGIN'] or not g.participant or
                    not hmac.compare_digest(request.headers.get('X-CSRF-Token', ''), g.participant['csrf_token'])):
                return jsonify(error='INVALID_ORIGIN_OR_CSRF'), 403

    @app.after_request
    def headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Frame-Options'] = 'DENY'
        return response


def _register_error_handlers(app):
    for error_type in (CheckoutError, GroupError, BookingError, AIError, ExpenseError, ReceiptScanError):
        app.register_error_handler(error_type, lambda error: (jsonify(error=error.issue), error.status))

    @app.errorhandler(PayPalError)
    def paypal_error(error):
        return jsonify(error=error.issue, debugID=error.debug_id), error.status

    @app.errorhandler(404)
    def not_found(_):
        return jsonify(error='NOT_FOUND'), 404

    @app.errorhandler(400)
    def invalid_json(_):
        return jsonify(error='INVALID_REQUEST'), 400

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(error='PAYLOAD_TOO_LARGE'), 413


def _register_blueprints(app):
    from .expenses.routes import blueprint as expenses_blueprint
    from .groups.routes import blueprint as groups_blueprint
    from .web.routes import blueprint as web_blueprint
    from .workshops.routes import blueprint as workshops_blueprint

    app.register_blueprint(web_blueprint)
    app.register_blueprint(groups_blueprint)
    app.register_blueprint(workshops_blueprint)
    app.register_blueprint(expenses_blueprint)
