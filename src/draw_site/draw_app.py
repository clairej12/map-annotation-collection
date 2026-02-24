from src.shared.factory import create_app
from src.shared.shared_routes import register_shared_routes
from src.shared.static_routes import register_static_routes
from src.shared.batch_routes import register_batch_routes
from src.shared.answer_routes import register_answer_routes

# draw-only endpoints live here
from flask import render_template, session, jsonify, request, url_for
from flask_login import login_required, current_user
import os, base64
from datetime import datetime, timezone
from src.shared.models import db, Task, Drawing
from pathlib import Path

app = create_app("draw")
register_shared_routes(app)
register_static_routes(app)
register_batch_routes(app)
register_answer_routes(app)

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
    data = request.json or {}
    task_id = data.get("task_id")
    image_base64 = data.get("image", "")

    if not task_id or not image_base64.startswith("data:image"):
        return jsonify(success=False, error="Invalid payload"), 400

    try:
        image_data = image_base64.split(",")[1]
    except IndexError:
        return jsonify(success=False, error="Invalid base64 image data"), 400

    try:
        image_bytes = base64.b64decode(image_data)
    except base64.binascii.Error:
        return jsonify(success=False, error="Base64 decoding failed"), 400

    USER_DRAWINGS_DIR.mkdir(parents=True, exist_ok=True)

    filename = f"{current_user.id}_{task_id}.png"
    filepath = os.path.join(USER_DRAWINGS_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(image_bytes)

    task = Task.query.get(task_id)
    if not task:
        return jsonify(success=False, error="Unknown task_id"), 400
    drawing = Drawing.query.filter_by(user_id=current_user.id, task_id=task_id).first()
    if drawing:
        if drawing.drawing_path is None:
            task.served_count_draw += 1
        drawing.drawing_path = filepath
        drawing.timestamp = datetime.now(timezone.utc)
    else:
        task.served_count_draw += 1
        drawing = Drawing(
            user_id=current_user.id,
            task_id=task_id,
            drawing_path=filepath,
            timestamp=datetime.now(timezone.utc),
        )
        db.session.add(drawing)

    db.session.commit()

    return jsonify(success=True, file=url_for("get_user_drawing", fname=filename))


"""
gunicorn --bind 0.0.0.0:5000 \
    --workers 3 --threads 2 \
    --limit-request-line 4094 \
    --limit-request-fields 50 \
    --limit-request-field_size 8190 \
    src.draw_site.draw_app:app
"""
