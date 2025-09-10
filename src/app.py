import os, json, csv
from src.config       import Config
from flask        import Flask, render_template, request, redirect, url_for, jsonify, session, send_file
from flask_login  import LoginManager, login_user, login_required, current_user, logout_user, UserMixin
import uuid
from src.models       import db, User, Task, Response
from datetime     import datetime, timezone
from src.utils        import parse_routes
from sqlalchemy import func
from sqlalchemy.orm import aliased
from sqlalchemy import and_
import random
import pdb
import base64

# ——— Flask & DB setup —————————————————————————————————————————————————————————
app = Flask(__name__)
app.config.from_object(Config)
db.init_app(app)

login_mgr = LoginManager(app)
login_mgr.init_app(app)
login_mgr.login_view = "login_page"

# ——— Preload tasks from your JSON into the Task table —————————————————————————
routes_data = parse_routes()

# ensure Task table populated
task_idx = 0
with app.app_context():
    db.create_all()
    for route_id, rd in routes_data.items():
        task_idx += 1
        if not Task.query.get(task_idx):
            db.session.add(Task(id=task_idx, 
                                route_id=rd['route_id'],
                                landmarks=rd['landmarks']))
    db.session.commit()

# ——— Login stub ————————————————————————————————————————————————————————————

@login_mgr.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

@app.route("/login_page", methods=["GET"])
def login_page():
    return render_template("login.html")

@app.route("/authenticate", methods=["POST"])
def authenticate():
    """
    Front-end will POST { user_id: <string> } here.
    If no user_id is supplied, generate one and create a new user.
    """
    payload = request.get_json()
    user_id = payload.get("user_id")
    study_id = payload.get("study_id")

    # Hardcoded study id check
    HARDCODED_STUDY_ID = "ClaireTest123"
    if study_id != HARDCODED_STUDY_ID:
        return jsonify({"status": "error", "message": "Invalid study ID"}), 403

    user = User.query.filter_by(hit_id=user_id).first()
    if not user:
        print(f"Added new user ID: {user_id}")
        user = User(hit_id=user_id)
        db.session.add(user)
        db.session.commit()

    session["study_id"] = study_id
    login_user(user)
    return jsonify({"status": "ok", "hit_id": user.hit_id, "study_id": study_id}), 200

@app.route("/logout")
def logout():
    logout_user()
    return redirect(url_for("login_page"))

# ——— Endpoints —————————————————————————————————————————————————————————————
# RENDER SURVEY PAGE
@app.route("/")
@login_required
def survey():
    return render_template("survey.html", 
                           user_id=current_user.hit_id,
                           study_id=session.get("study_id"))

@app.route("/quiz")
@login_required
def serve_quiz():
    pass

@app.route("/submit_quiz")
@login_required
def submit_quiz():
    pass

# NEXT BATCH
@app.route("/next_batch")
@login_required
def next_batch():
    print(f"User {current_user.id} requested next batch")
    
    def make_trajectory(t):
        # logic to grab the first `t.cutoff_idx` images
        images = [ f"{image_filename}"
                   for image_filename in routes_data[t.route_id]["observations"]]
        return {
            "task_id":    t.id,
            "map_url":    f"{routes_data[t.route_id]['map']}",
            "images":     images,
            "landmarks": t.landmarks,
        }

    # check if user is already in a batch
    if current_user.inflight_batch: # user is already in a batch, return the same tasks with the saved answers
        tasks = db.session.query(Task).filter(Task.id.in_(current_user.last_batch)).all()
    else: # pick 10 least-served tasks the user hasn't answered
        # Subquery: tasks the user already answered
        subq = db.session.query(Response.task_id).filter_by(user_id=current_user.id)

        least_id_per_route = (
            db.session.query(
                Task.route_id,
                func.max(Task.id).label('max_id')
            )
            .filter(Task.served_count == 0)
            .filter(~Task.id.in_(subq))
            .group_by(Task.route_id)
            .subquery()
        )

        tasks = (
            Task.query
                .join(least_id_per_route, Task.id == least_id_per_route.c.max_id)
                .order_by(Task.route_id)
                .limit(10)
                .all()
        )

        # update the user's last_batch
        last_batch = [t.id for t in tasks]
        db.session.query(User).filter_by(id=current_user.id).update({"last_batch": last_batch})
    
        # mark user as in-flight
        db.session.query(User).filter_by(id=current_user.id).update({"inflight_batch": True})
        db.session.commit()

    print(f"Tasks: {[t.id for t in tasks]}")

    saved = {}
    for r in Response.query.filter_by(user_id=current_user.id).filter(
            Response.task_id.in_([t.id for t in tasks]),
        ).all():
        drawing = None
        if r.drawing_path and os.path.exists(r.drawing_path):
            with open(r.drawing_path, "rb") as f:
                drawing_data = f.read()
            drawing = f"data:image/png;base64,{base64.b64encode(drawing_data).decode('utf-8')}"
        saved[r.task_id] = {
            "landmarks": r.landmarks,
            "drawing": drawing
        }

    return jsonify({
        "trajectories": [make_trajectory(t) for t in tasks],
        "saved_answers": saved
    })

# STATIC SERVING
MAPS_DIR = "/data/claireji/maps/easy_processed_maps_v2/"
OBSERVATIONS_DIR = "/home/claireji/napkin-map/MapDataCollection/data/thumbnails_sharpened/"
@app.route("/maps/<path:fname>")
def get_map(fname):
    # print(f"Serving map file: {fname}")
    return send_file(os.path.join(MAPS_DIR, fname))

@app.route("/observations/<path:fname>")
def get_image(fname):
    # print(f"Serving observation file: {fname}")
    return send_file(os.path.join(OBSERVATIONS_DIR, fname))

@app.route("/save_drawing", methods=["POST"])
@login_required
def save_drawing():
    """
    Save the current canvas drawing for a specific user/task.
    Expects JSON:
    {
        "task_id": int,
        "image": "data:image/png;base64,...."
    }
    """
    data = request.json or {}
    task_id = data.get("task_id")
    image_base64 = data.get("image", "")

    if not task_id or not image_base64.startswith("data:image"):
        return jsonify(success=False, error="Invalid payload"), 400

    # Remove "data:image/png;base64," prefix
    try:
        image_data = image_base64.split(",")[1]
    except IndexError:
        return jsonify(success=False, error="Invalid base64 image data"), 400

    # Decode image
    try:
        image_bytes = base64.b64decode(image_data)
    except base64.binascii.Error:
        return jsonify(success=False, error="Base64 decoding failed"), 400

    # Ensure drawings dir exists
    save_dir = "user_drawings"
    os.makedirs(save_dir, exist_ok=True)

    # Save file named by user_id and task_id
    filename = f"{current_user.id}_{task_id}.png"
    filepath = os.path.join(save_dir, filename)
    with open(filepath, "wb") as f:
        f.write(image_bytes)

    # Update DB Response entry for this user/task
    task = Task.query.get(task_id)
    resp = Response.query.filter_by(user_id=current_user.id, task_id=task_id).first()
    if resp:
        resp.drawing_path = filepath
        resp.timestamp = datetime.now(timezone.utc)
    else:
        task.served_count += 1
        # Create minimal response entry if none exists
        resp = Response(
            user_id=current_user.id,
            task_id=task_id,
            drawing_path=filepath,
            timestamp=datetime.now(timezone.utc)
        )
        db.session.add(resp)

    db.session.commit()

    return jsonify(success=True, file=filename)

@app.route("/save_landmarks", methods=["POST"])
@login_required
def save_landmarks():
    """
    Save only the landmark annotations for a specific user/task.
    Expects JSON:
    {
        "task_id": int,
        "landmarks": ["point1", "point2", ...]
    }
    """
    data = request.json or {}
    task_id = data.get("task_id")
    landmarks = data.get("landmarks", [])

    if not task_id:
        return jsonify(success=False, error="Invalid payload"), 400

    ts = datetime.now(timezone.utc)
    task = Task.query.get(task_id)

    # DB: may or may not already exist
    resp = Response.query.filter_by(user_id=current_user.id, task_id=task_id).first()

    if resp:
        resp.landmarks = landmarks
        resp.timestamp = ts
    else:
        # Create minimal response entry if none exists
        task.served_count += 1
        resp = Response(
            user_id=current_user.id,
            task_id=task_id,
            landmarks=landmarks,
            timestamp=ts
        )
        db.session.add(resp)

    db.session.commit()

    # Save to per-user JSON file (similar to save_answer)
    save_dir = "user_landmarks"
    os.makedirs(save_dir, exist_ok=True)
    filename = os.path.join(save_dir, f"{current_user.id}_landmarks.json")

    # Load existing data
    file_data = []
    if os.path.exists(filename):
        with open(filename, "r") as f:
            try:
                file_data = json.load(f)
            except json.JSONDecodeError:
                file_data = []

    # Update or add entry
    existing_entry = next((d for d in file_data if d["task_id"] == task_id), None)
    if not existing_entry:
        file_data.append({
            "task_id": task_id,
            "landmarks": landmarks,
            "timestamp": ts.isoformat()
        })
    else:
        existing_entry["landmarks"] = landmarks
        existing_entry["timestamp"] = ts.isoformat()

    # Write back
    with open(filename, "w") as f:
        json.dump(file_data, f, indent=2)

    return jsonify(success=True, landmarks=landmarks)

# SAVE ANSWERS
@app.route("/save_answer", methods=["POST"])
@login_required
def save_answer():
    """
    Save drawing board or annotation results from front-end.
    Expected JSON payload (example):
    {
        "task_id": 123,
        "landmarks": ["point1", "point2"],
        "metrics": "{}"
    }
    """
    ans = request.json or {}
    ts = datetime.now(timezone.utc)

    # Extract fields from payload
    task_id = ans.get("task_id")
    landmarks = ans.get("landmarks", [])
    metrics = ans.get("metrics", {})
    duration = float(metrics.get("durationMs", 0.0))
    click_counts = metrics.get("clickCounts", [])

    task = Task.query.get(task_id)

    # DB: response should already present
    existing = Response.query.filter_by(
        user_id=current_user.id,
        task_id=task.id,
    ).first()

    if not existing:
        return jsonify({"status": "failed - no existing entry from saved landmarks and drawing"})
    else:
        # update existing response
        existing.landmarks = landmarks
        existing.duration = (existing.duration or 0) + duration
        existing.timestamp = ts

        try:
            prev_clicks = json.loads(existing.clickCounts or "{}")
        except json.JSONDecodeError:
            prev_clicks = {}

        # Merge click counts dict of lists
        for key, val in click_counts.items():
            prev_clicks[key] = (prev_clicks.get(key, 0) or 0) + val

        existing.clickCounts = json.dumps(prev_clicks)
    db.session.commit()

    # Save to per-user JSON file (simple)
    save_dir = "user_answers"
    os.makedirs(save_dir, exist_ok=True)
    filename = os.path.join(save_dir, f"{current_user.id}_answers.json")

    # Load old saves if any
    data = []
    if os.path.exists(filename):
        with open(filename, "r") as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                data = []

    # Look for existing record for this task
    existing_entry = next((d for d in data if d["task_id"] == task_id), None)

    if not existing_entry:
        # First save for this task
        # Append new record
        data.append({
            "task_id": task_id,
            "drawing_path": existing.drawing_path,
            "landmarks": landmarks,
            "metrics": metrics,
            "timestamp": ts.isoformat()
        })
    else:
        # Replace landmarks
        existing_entry["landmarks"] = landmarks

        # Sum durationMs
        prev_duration = float(existing_entry.get("metrics", {}).get("durationMs", 0))
        existing_entry["metrics"]["durationMs"] = prev_duration + duration

        # Merge clickCounts dict of lists
        prev_clicks = existing_entry["metrics"].get("clickCounts", {})
        for key, vals in click_counts.items():
            prev_clicks[key] = prev_clicks.get(key, 0) + vals
        existing_entry["metrics"]["clickCounts"] = prev_clicks

        # Update timestamp
        existing_entry["timestamp"] = ts.isoformat()

    # Write back
    with open(filename, "w") as f:
        json.dump(data, f, indent=2)

    return jsonify({"status": "ok"})

@app.route("/submit_answers", methods=["POST"])
@login_required
def submit_answers():
    # mark the batch as done so next /next_batch is fresh
    current_user.inflight_batch = False
    db.session.commit()
    return "", 204

if __name__=="__main__":
    # app.run(debug=True)
    app.run(host="0.0.0.0", port=5000, debug=False)

"""
pip install gunicorn            # once
gunicorn --bind 0.0.0.0:8000 wsgi:app
gunicorn --bind 0.0.0.0:8000 src.app:app
"""
