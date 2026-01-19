import os, json, csv
from src.config       import Config
from flask        import Flask, render_template, request, redirect, url_for, jsonify, session, send_file, send_from_directory
from flask_login  import LoginManager, login_user, login_required, current_user, logout_user, UserMixin
import uuid
from src.models       import db, User, Task, Response
from datetime     import datetime, timezone
from src.utils        import parse_routes
from sqlalchemy import func
from sqlalchemy.orm import aliased
from sqlalchemy import and_
import pdb
import base64
from pathlib import Path

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
with app.app_context():
    db.create_all()

    for _, rd in routes_data.items():
        rid = rd["route_id"]

        # find by route_id, not by numeric id
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
            # update existing fields in case JSON changed
            t.landmarks = rd["landmarks"]
            t.endpoints = rd["endpoints"]

    db.session.commit()

# ——— Login stub ————————————————————————————————————————————————————————————

def _get_param(name):
    return request.args.get(name) or request.form.get(name)

@app.route("/prolific", methods=["GET"])
def prolific_entry():
    """
    Prolific will send users here like:
    /prolific?PROLIFIC_PID=...&STUDY_ID=...&SESSION_ID=...
    """
    prolific_pid = _get_param("PROLIFIC_PID")
    prolific_study_id = _get_param("STUDY_ID")
    prolific_session_id = _get_param("SESSION_ID")

    # Require at least PROLIFIC_PID (recommended)
    if not prolific_pid:
        return "Missing PROLIFIC_PID", 400

    # Create a stable internal hit_id (or use prolific_session_id)
    internal_hit_id = f"{prolific_pid}_{prolific_session_id}_{prolific_study_id}"

    user = User.query.filter_by(hit_id=internal_hit_id).first()
    if not user:
        user = User(hit_id=internal_hit_id)

    # Store prolific info
    user.prolific_pid = prolific_pid
    user.prolific_study_id = prolific_study_id
    user.prolific_session_id = prolific_session_id
    user.last_seen_at = datetime.now(timezone.utc)

    db.session.add(user)
    db.session.commit()

    # Put what you want in server session too
    session["prolific_pid"] = prolific_pid
    session["prolific_study_id"] = prolific_study_id
    session["prolific_session_id"] = prolific_session_id

    session["user_id"] = f"{prolific_pid}_{prolific_session_id}"
    session["study_id"] = prolific_study_id

    login_user(user)

    # send them into your actual app page
    return redirect(url_for("survey"))  # change to your real landing route

@app.get("/api/whoami")
@login_required
def whoami():
    return {
        "prolific_pid": session.get("prolific_pid"),
        "prolific_study_id": session.get("prolific_study_id"),
        "prolific_session_id": session.get("prolific_session_id"),
        "user_id": session.get("user_id"),
    }

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
    
    if not user_id:
        return jsonify({"status": "error", "message": "Missing user ID"}), 400

    user = User.query.filter_by(hit_id=user_id).first()
    if not user:
        print(f"Added new user ID: {user_id}")
        user = User(hit_id=user_id)
        db.session.add(user)
        db.session.commit()

    session["user_id"] = user_id
    session["study_id"] = study_id
    login_user(user)
    return jsonify({"status": "ok", "hit_id": user.hit_id, "study_id": study_id}), 200

@app.route("/logout")
def logout():
    logout_user()
    return redirect(url_for("login_page"))

@app.route("/complete", methods=["POST"])
@login_required
def complete():
    current_user.inflight_batch = False
    db.session.commit()
    completion_url = "https://app.prolific.com/submissions/complete?cc=CS6Z1JEG"
    return jsonify({
        "status": "ok",
        "completion_url": completion_url
    })

# ——— Endpoints —————————————————————————————————————————————————————————————
# RENDER SURVEY PAGE
@app.route("/")
@login_required
def survey():
    return render_template("survey.html", 
                           user_id=session.get("user_id", ""),
                           study_id=session.get("study_id", ""))

@app.route("/quiz")
@login_required
def serve_quiz():
    pass

@app.route("/check_quiz", methods=["POST"])
@login_required
def check_quiz():
    data = request.get_json()
    user_order = data.get("order", [])

    # Define one or more correct sequences
    correct_orders = [
        [
            "Start (S)",
            "First intersection with crosswalks",
            "Second intersection with crosswalks",
            "Point B",
            "Third intersection with cross walks",
            "Pass through fourth intersection with cross walks",
            "Turn onto alleyway",
            "Parking spots on either side of the street",
            "Point C",
            "Tall brick buildings on either side",
            "Pass through fifth intersection with crosswalks",
            "Turn onto Public Alley",
            "Parking spots on either side of the street",
            "Point A",
            "Turn out of alleyway",
            "Pass through sixth intersection with crosswalks",
            "Pass seventh intersection with crosswalks",
            "Park with grass and trees on either side of the street",
            "Turn at eighth intersection with crosswalks",
            "End (G)"
        ],
        [
            "Start (S)",
            "First intersection with crosswalks",
            "Second intersection with crosswalks",
            "Point B",
            "Third intersection with cross walks",
            "Pass through fourth intersection with cross walks",
            "Turn onto alleyway",
            "Parking spots on either side of the street",
            "Point C",
            "Tall brick buildings on either side",
            "Pass through fifth intersection with crosswalks",
            "Turn onto Public Alley",
            "Point A",
            "Parking spots on either side of the street",
            "Turn out of alleyway",
            "Pass through sixth intersection with crosswalks",
            "Pass seventh intersection with crosswalks",
            "Park with grass and trees on either side of the street",
            "Turn at eighth intersection with crosswalks",
            "End (G)"
        ],
    ]

    is_correct = any(user_order == correct for correct in correct_orders)
    return jsonify({"correct": is_correct})

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
            "video": f"{t.route_id}.mp4",
            "landmarks": t.landmarks,
            "endpoint_order": t.endpoints,
        }

    # check if user is already in a batch
    if current_user.inflight_batch: # user is already in a batch, return the same tasks with the saved answers
        tasks = db.session.query(Task).filter(Task.id.in_(current_user.last_batch)).all()
    else: # pick 6 least-served tasks the user hasn't answered
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
                .limit(4)
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
# MAPS_DIR = "/home/claireji/napkin-map/route-creation/route_maps/"
# OBSERVATIONS_DIR = "/data/claireji/thumbnails/" # "/home/claireji/napkin-map/route-creation/streetview_images/"
APP_DIR = Path(__file__).resolve().parent
MAPS_DIR = "/home/claireji/napkin-map/route_creation_jacob/maps/"
OBSERVATIONS_DIR = "/data/claireji/mapillary_jacob/mapillary/day2_seg13_images/"
USER_DRAWINGS_DIR = (APP_DIR / ".." / "user_drawings").resolve()
VIDEO_DIR = "/data/claireji/mapillary_jacob/mapillary/videos/"

@app.route("/videos/<path:filename>")
def serve_video(filename):
    return send_from_directory(VIDEO_DIR, filename)

@app.route("/maps/<path:fname>")
def get_map(fname):
    # print(f"Serving map file: {fname}")
    return send_file(os.path.join(MAPS_DIR, fname))

@app.route("/observations/<path:fname>")
def get_image(fname):
    # print(f"Serving observation file: {fname}")
    return send_file(os.path.join(OBSERVATIONS_DIR, fname))

@app.route("/user_drawings/<path:fname>")
def get_user_drawing(fname):
    return send_from_directory(USER_DRAWINGS_DIR, fname)

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
    USER_DRAWINGS_DIR.mkdir(parents=True, exist_ok=True)
    
    # Save file named by user_id and task_id
    filename = f"{current_user.id}_{task_id}.png"
    filepath = os.path.join(USER_DRAWINGS_DIR, filename)
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

    print(f"Saved drawing for user {current_user.id}, task {task_id} at {filepath}")
    return jsonify(success=True, file=url_for("get_user_drawing", fname=filename))

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

def _safe_float(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default

def _safe_int(x, default=0):
    try:
        return int(x)
    except (TypeError, ValueError):
        return default

def _merge_numeric(dst: dict, src: dict):
    """
    Add src numeric fields into dst (dst[k] += src[k]).
    Only for numbers; ignores non-numeric.
    """
    for k, v in (src or {}).items():
        if isinstance(v, (int, float)):
            dst[k] = (dst.get(k, 0) or 0) + v

def _merge_metrics(prev: dict, incoming: dict) -> dict:
    """
    Merge your new task_metrics structure in an additive way.
    - timing: keep latest pageEnterMs / landmarkEnterMs, sum durations if provided
    - video: sum counts/time, max maxWatchedTime, handle lastPlayStartedMs by overwriting
    - interactions: sum counts, overwrite timestamps for clicks
    """
    if not isinstance(prev, dict):
        prev = {}
    if not isinstance(incoming, dict):
        return prev

    out = prev

    # --- timing ---
    out.setdefault("timing", {})
    inc_t = incoming.get("timing") or {}
    if isinstance(inc_t, dict):
        # overwrite "enter" markers (latest)
        for k in ["pageEnterMs", "firstInteractionMs", "landmarkEnterMs"]:
            if inc_t.get(k) is not None:
                out["timing"][k] = inc_t.get(k)

        # durations: SUM (because you autosave multiple times)
        for k in ["drawingDurationMs", "landmarkDurationMs"]:
            if inc_t.get(k) is not None:
                out["timing"][k] = _safe_float(out["timing"].get(k), 0.0) + _safe_float(inc_t.get(k), 0.0)

    # --- video ---
    out.setdefault("video", {})
    inc_v = incoming.get("video") or {}
    if isinstance(inc_v, dict):
        # sum counts/times
        for k in ["playCount", "pauseCount", "seekCount", "totalWatchTimeMs"]:
            if inc_v.get(k) is not None:
                out["video"][k] = _safe_float(out["video"].get(k), 0.0) + _safe_float(inc_v.get(k), 0.0)

        # max watched time: MAX
        if inc_v.get("maxWatchedTime") is not None:
            out["video"]["maxWatchedTime"] = max(
                _safe_float(out["video"].get("maxWatchedTime"), 0.0),
                _safe_float(inc_v.get("maxWatchedTime"), 0.0),
            )

        # lastPlayStartedMs is “stateful”; overwrite with newest
        if "lastPlayStartedMs" in inc_v:
            out["video"]["lastPlayStartedMs"] = inc_v.get("lastPlayStartedMs")

    # --- interactions ---
    out.setdefault("interactions", {})
    inc_i = incoming.get("interactions") or {}
    if isinstance(inc_i, dict):
        # counters: sum
        for k in ["addLandmark", "deleteLandmark", "reorderLandmark", "undo", "redo"]:
            if inc_i.get(k) is not None:
                out["interactions"][k] = _safe_int(out["interactions"].get(k), 0) + _safe_int(inc_i.get(k), 0)

        # timestamps: overwrite (keep latest click times)
        for k in ["clickedGoToLandmarksMs", "clickedSaveNextMs", "saveAndNextMs"]:
            if inc_i.get(k) is not None:
                out["interactions"][k] = inc_i.get(k)

    # --- drawing ---
    out.setdefault("drawing", {})
    inc_d = incoming.get("drawing") or {}
    if isinstance(inc_d, dict):
        if inc_d.get("strokeCount") is not None:
            out["drawing"]["strokeCount"] = _safe_int(out["drawing"].get("strokeCount"), 0) + _safe_int(inc_d.get("strokeCount"), 0)

        for k in ["firstStrokeMs", "lastStrokeMs"]:
            if inc_d.get(k) is not None:
                # keep earliest firstStrokeMs, latest lastStrokeMs
                if k == "firstStrokeMs":
                    cur = out["drawing"].get(k)
                    out["drawing"][k] = inc_d.get(k) if cur is None else min(cur, inc_d.get(k))
                else:
                    out["drawing"][k] = inc_d.get(k)

        # points: optional—keep last N points
        if isinstance(inc_d.get("points"), list):
            prev_pts = out["drawing"].get("points") if isinstance(out["drawing"].get("points"), list) else []
            merged_pts = prev_pts + inc_d.get("points")
            out["drawing"]["points"] = merged_pts[-2000:]

    return out

@app.route("/save_answer", methods=["POST"])
@login_required
def save_answer():
    """
    New preferred payload:
    {
      "task_id": 123,
      "landmarks": [...],
      "drawing": "...",                  # optional
      "task_metrics": { timing, video, interactions },
      "prolific": {...},                 # optional
      "quiz": {...}                      # optional
    }

    Back-compat:
    - old: {"metrics": {"durationMs":..., "clickCounts": {...}}}
    - older-new: {"drawing_duration_ms":..., "landmark_duration_ms":..., "click_counts": {...}}
    """
    ans = request.get_json(silent=True) or {}
    ts = datetime.now(timezone.utc)

    task_id = ans.get("task_id")
    landmarks = ans.get("landmarks", [])

    if task_id is None:
        return jsonify({"status": "failed - missing task_id"}), 400

    task = Task.query.get(task_id)
    if not task:
        return jsonify({"status": "failed - unknown task_id"}), 400

    # --- incoming metrics ---
    incoming_task_metrics = ans.get("task_metrics")
    if not isinstance(incoming_task_metrics, dict):
        incoming_task_metrics = None

    # --- back-compat: old / flat metrics -> convert into task_metrics-ish ---
    if incoming_task_metrics is None:
        incoming_task_metrics = {}

        metrics_in = ans.get("metrics")
        if isinstance(metrics_in, dict):
            # old style
            duration = _safe_float(metrics_in.get("durationMs"), 0.0)
            cc = metrics_in.get("clickCounts") if isinstance(metrics_in.get("clickCounts"), dict) else {}

            incoming_task_metrics["timing"] = {
                "drawingDurationMs": duration,  # we don't know split; put it here
            }
            incoming_task_metrics["interactions"] = {}  # old clickCounts not the same anymore
            incoming_task_metrics["video"] = {}
            # if you still want to keep clickCounts somewhere:
            if cc:
                incoming_task_metrics["legacy_clickCounts"] = {k: _safe_int(v, 0) for k, v in cc.items()}
        else:
            # older "new style" separate fields
            drawing_dur = _safe_float(ans.get("drawing_duration_ms"), 0.0)
            landmark_dur = _safe_float(ans.get("landmark_duration_ms"), 0.0)
            cc = ans.get("click_counts") if isinstance(ans.get("click_counts"), dict) else {}

            incoming_task_metrics["timing"] = {
                "drawingDurationMs": drawing_dur,
                "landmarkDurationMs": landmark_dur,
            }
            if cc:
                incoming_task_metrics["legacy_clickCounts"] = {k: _safe_int(v, 0) for k, v in cc.items()}

    # --- DB lookup ---
    existing = Response.query.filter_by(user_id=current_user.id, task_id=task.id).first()
    if not existing:
        return jsonify({"status": "failed - no existing entry from saved landmarks and drawing"}), 400

    # --- update landmarks + timestamp ---
    existing.landmarks = landmarks
    existing.timestamp = ts

    # --- merge metrics JSON into DB ---
    # Recommended: store in existing.metrics_json (TEXT or JSON column).
    prev_metrics = {}
    try:
        prev_metrics = json.loads(existing.metrics_json) if getattr(existing, "metrics_json", None) else {}
        if not isinstance(prev_metrics, dict):
            prev_metrics = {}
    except Exception:
        prev_metrics = {}

    merged = _merge_metrics(prev_metrics, incoming_task_metrics)
    existing.metrics_json = json.dumps(merged)

    # Optional: if you still keep duration column, derive it from merged timing
    # (so your old reporting doesn't break)
    try:
        drawing_ms = _safe_float((merged.get("timing") or {}).get("drawingDurationMs"), 0.0)
        landmark_ms = _safe_float((merged.get("timing") or {}).get("landmarkDurationMs"), 0.0)
        existing.duration = (drawing_ms + landmark_ms) / 1000.0  # store seconds if your DB expects seconds
    except Exception:
        pass

    db.session.commit()

    # --- mirror to per-user JSON file ---
    save_dir = "user_answers"
    os.makedirs(save_dir, exist_ok=True)
    filename = os.path.join(save_dir, f"{current_user.id}_answers.json")

    data = []
    if os.path.exists(filename):
        with open(filename, "r") as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                data = []

    entry = next((d for d in data if d.get("task_id") == task_id), None)
    if not entry:
        entry = {
            "task_id": task_id,
            "drawing_path": getattr(existing, "drawing_path", None),
            "landmarks": landmarks,
            "task_metrics": incoming_task_metrics,
            "timestamp": ts.isoformat(),
            "prolific": current_user.hit_id,
        }
        data.append(entry)
    else:
        entry["landmarks"] = landmarks

        # merge existing file metrics too
        prev_file_metrics = entry.get("task_metrics") if isinstance(entry.get("task_metrics"), dict) else {}
        entry["task_metrics"] = _merge_metrics(prev_file_metrics, incoming_task_metrics)
        entry["timestamp"] = ts.isoformat()

    with open(filename, "w") as f:
        json.dump(data, f, indent=2)

    return jsonify({"status": "ok"})

if __name__=="__main__":
    # app.run(debug=True)
    app.run(host="0.0.0.0", port=5000, debug=False)

"""
pip install gunicorn            # once
gunicorn --bind 0.0.0.0:8000 wsgi:app
gunicorn --bind 0.0.0.0:8000 src.app:app
"""
