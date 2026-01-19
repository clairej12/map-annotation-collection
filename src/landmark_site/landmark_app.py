from src.shared.factory import create_app
from src.shared.shared_routes import register_shared_routes
from src.shared.static_routes import register_static_routes
from src.shared.batch_routes import register_batch_routes
from src.shared.answer_routes import register_answer_routes
from src.shared.models import db, Task, Landmark

from flask import render_template, session, jsonify, request
from flask_login import login_required, current_user

from datetime import datetime, timezone
import os, json

app = create_app("landmarks")
register_shared_routes(app)
register_static_routes(app)
register_batch_routes(app)
register_answer_routes(app)

@app.route("/")
@login_required
def landmark_survey():
    return render_template(
        "landmark_survey.html",
        user_id=session.get("user_id", ""),
        study_id=session.get("study_id", "")
    )

@app.route("/save_landmarks", methods=["POST"])
@login_required
def save_landmarks():
    data = request.json or {}
    task_id = data.get("task_id")
    landmarks = data.get("landmarks", [])

    if not task_id:
        return jsonify(success=False, error="Invalid payload"), 400

    ts = datetime.now(timezone.utc)
    task = Task.query.get(task_id)
    if not task:
        return jsonify(success=False, error="Unknown task_id"), 400

    entry = Landmark.query.filter_by(user_id=current_user.id, task_id=task_id).first()
    if entry:
        entry.landmarks = landmarks
        entry.timestamp = ts
    else:
        task.served_count_landmarks += 1
        entry = Landmark(
            user_id=current_user.id,
            task_id=task_id,
            landmarks=landmarks,
            timestamp=ts,
        )
        db.session.add(entry)

    db.session.commit()

    save_dir = "user_landmarks"
    os.makedirs(save_dir, exist_ok=True)
    filename = os.path.join(save_dir, f"{current_user.id}_landmarks.json")

    file_data = []
    if os.path.exists(filename):
        with open(filename, "r") as f:
            try:
                file_data = json.load(f)
            except json.JSONDecodeError:
                file_data = []

    existing_entry = next((d for d in file_data if d.get("task_id") == task_id), None)
    if not existing_entry:
        file_data.append({
            "task_id": task_id,
            "landmarks": landmarks,
            "timestamp": ts.isoformat(),
        })
    else:
        existing_entry["landmarks"] = landmarks
        existing_entry["timestamp"] = ts.isoformat()

    with open(filename, "w") as f:
        json.dump(file_data, f, indent=2)

    return jsonify(success=True, landmarks=landmarks)
