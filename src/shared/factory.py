from flask import Flask
from flask_login import LoginManager
from src.config import Config
from src.models import db, Task
from src.utils import parse_routes

def create_app(mode: str) -> Flask:
    """
    mode: 'draw' or 'landmarks'
    """
    app = Flask(__name__)
    app.config.from_object(Config)
    app.config["APP_MODE"] = mode  # useful in templates/JS if needed

    db.init_app(app)

    login_mgr = LoginManager()
    login_mgr.init_app(app)
    login_mgr.login_view = "login_page"

    # --- preload tasks (same as your unified app) ---
    routes_data = parse_routes()
    app.extensions["routes_data"] = routes_data  # stash for route handlers

    with app.app_context():
        db.create_all()
        for _, rd in routes_data.items():
            rid = rd["route_id"]
            t = Task.query.filter_by(route_id=rid).first()
            if t is None:
                t = Task(
                    route_id=rid,
                    served_count=0,
                    landmarks=rd["landmarks"],
                    endpoints=rd["endpoints"],
                )
                db.session.add(t)
            else:
                t.landmarks = rd["landmarks"]
                t.endpoints = rd["endpoints"]
        db.session.commit()

    # attach login user_loader (needs User model)
    from src.models import User

    @login_mgr.user_loader
    def load_user(user_id):
        return User.query.get(int(user_id))

    return app