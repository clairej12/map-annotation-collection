from src.common.factory import create_app
from src.common.shared_routes import register_shared_routes
from src.common.static_routes import register_static_routes
from src.common.batch_routes import register_batch_routes

# draw-only endpoints live here
from flask import render_template, session, jsonify
from flask_login import login_required
import os, base64
from datetime import datetime, timezone
from src.models import db, Task, Response
from pathlib import Path

app = create_app("draw")
register_shared_routes(app)
register_static_routes(app)
register_batch_routes(app)

APP_DIR = Path(__file__).resolve().parent
USER_DRAWINGS_DIR = (APP_DIR / ".." / "user_drawings").resolve()

@app.route("/")
@login_required
def draw_survey():
    return render_template(
        "draw_survey.html",
        user_id=session.get("user_id", ""),
        study_id=session.get("study_id", "")
    )

@app.route("/save_drawing", methods=["POST"])
@login_required
def save_drawing():
    data = app.current_request_context.request.json if False else None  # ignore; see below


"""
gunicorn --bind 0.0.0.0:5000 src.draw_app:app
"""