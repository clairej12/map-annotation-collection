import json
import os
from datetime import datetime, timezone
from flask import request, jsonify
from flask_login import login_required, current_user
from src.shared.models import db, Task, Drawing, Landmark


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


def _merge_metrics(prev: dict, incoming: dict) -> dict:
    if not isinstance(prev, dict):
        prev = {}
    if not isinstance(incoming, dict):
        return prev

    out = prev

    out.setdefault("timing", {})
    inc_t = incoming.get("timing") or {}
    if isinstance(inc_t, dict):
        for k in ["pageEnterMs", "firstInteractionMs", "landmarkEnterMs"]:
            if inc_t.get(k) is not None:
                out["timing"][k] = inc_t.get(k)
        for k in ["drawingDurationMs", "landmarkDurationMs"]:
            if inc_t.get(k) is not None:
                out["timing"][k] = _safe_float(out["timing"].get(k), 0.0) + _safe_float(inc_t.get(k), 0.0)

    out.setdefault("video", {})
    inc_v = incoming.get("video") or {}
    if isinstance(inc_v, dict):
        for k in ["playCount", "pauseCount", "seekCount", "totalWatchTimeMs"]:
            if inc_v.get(k) is not None:
                out["video"][k] = _safe_float(out["video"].get(k), 0.0) + _safe_float(inc_v.get(k), 0.0)
        if inc_v.get("maxWatchedTime") is not None:
            out["video"]["maxWatchedTime"] = max(
                _safe_float(out["video"].get("maxWatchedTime"), 0.0),
                _safe_float(inc_v.get("maxWatchedTime"), 0.0),
            )
        if "lastPlayStartedMs" in inc_v:
            out["video"]["lastPlayStartedMs"] = inc_v.get("lastPlayStartedMs")

    out.setdefault("interactions", {})
    inc_i = incoming.get("interactions") or {}
    if isinstance(inc_i, dict):
        for k in ["addLandmark", "deleteLandmark", "reorderLandmark", "undo", "redo"]:
            if inc_i.get(k) is not None:
                out["interactions"][k] = _safe_int(out["interactions"].get(k), 0) + _safe_int(inc_i.get(k), 0)
        for k in ["clickedGoToLandmarksMs", "clickedSaveNextMs", "saveAndNextMs"]:
            if inc_i.get(k) is not None:
                out["interactions"][k] = inc_i.get(k)

    out.setdefault("drawing", {})
    inc_d = incoming.get("drawing") or {}
    if isinstance(inc_d, dict):
        if inc_d.get("strokeCount") is not None:
            out["drawing"]["strokeCount"] = _safe_int(out["drawing"].get("strokeCount"), 0) + _safe_int(inc_d.get("strokeCount"), 0)

        for k in ["firstStrokeMs", "lastStrokeMs"]:
            if inc_d.get(k) is not None:
                if k == "firstStrokeMs":
                    cur = out["drawing"].get(k)
                    out["drawing"][k] = inc_d.get(k) if cur is None else min(cur, inc_d.get(k))
                else:
                    out["drawing"][k] = inc_d.get(k)

        if isinstance(inc_d.get("points"), list):
            prev_pts = out["drawing"].get("points") if isinstance(out["drawing"].get("points"), list) else []
            merged_pts = prev_pts + inc_d.get("points")
            out["drawing"]["points"] = merged_pts[-2000:]

    return out


def register_answer_routes(app):
    @app.route("/save_answer", methods=["POST"])
    @login_required
    def save_answer():
        ans = request.get_json(silent=True) or {}
        ts = datetime.now(timezone.utc)

        task_id = ans.get("task_id")
        landmarks = ans.get("landmarks", [])

        if task_id is None:
            return jsonify({"status": "failed - missing task_id"}), 400

        task = Task.query.get(task_id)
        if not task:
            return jsonify({"status": "failed - unknown task_id"}), 400

        incoming_task_metrics = ans.get("task_metrics")
        if not isinstance(incoming_task_metrics, dict):
            incoming_task_metrics = {}

            metrics_in = ans.get("metrics")
            if isinstance(metrics_in, dict):
                duration = _safe_float(metrics_in.get("durationMs"), 0.0)
                incoming_task_metrics["timing"] = {"drawingDurationMs": duration}
                incoming_task_metrics["interactions"] = {}
                incoming_task_metrics["video"] = {}
                cc = metrics_in.get("clickCounts") if isinstance(metrics_in.get("clickCounts"), dict) else {}
                if cc:
                    incoming_task_metrics["legacy_clickCounts"] = {k: _safe_int(v, 0) for k, v in cc.items()}
            else:
                drawing_dur = _safe_float(ans.get("drawing_duration_ms"), 0.0)
                landmark_dur = _safe_float(ans.get("landmark_duration_ms"), 0.0)
                incoming_task_metrics["timing"] = {
                    "drawingDurationMs": drawing_dur,
                    "landmarkDurationMs": landmark_dur,
                }
                cc = ans.get("click_counts") if isinstance(ans.get("click_counts"), dict) else {}
                if cc:
                    incoming_task_metrics["legacy_clickCounts"] = {k: _safe_int(v, 0) for k, v in cc.items()}

        mode = app.config.get("APP_MODE")
        if mode == "draw":
            entry = Drawing.query.filter_by(user_id=current_user.id, task_id=task_id).first()
            if not entry:
                entry = Drawing(user_id=current_user.id, task_id=task_id, timestamp=ts)
                db.session.add(entry)
        else:
            entry = Landmark.query.filter_by(user_id=current_user.id, task_id=task_id).first()
            if not entry:
                entry = Landmark(user_id=current_user.id, task_id=task_id, timestamp=ts)
                db.session.add(entry)
            entry.landmarks = landmarks

        entry.timestamp = ts

        prev_metrics = {}
        try:
            prev_metrics = json.loads(entry.metrics_json) if entry.metrics_json else {}
            if not isinstance(prev_metrics, dict):
                prev_metrics = {}
        except Exception:
            prev_metrics = {}

        merged = _merge_metrics(prev_metrics, incoming_task_metrics)
        entry.metrics_json = json.dumps(merged)

        db.session.commit()

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

        entry_data = next((d for d in data if d.get("task_id") == task_id), None)
        if not entry_data:
            entry_data = {
                "task_id": task_id,
                "drawing_path": getattr(entry, "drawing_path", None),
                "landmarks": landmarks,
                "mode": mode,
                "task_metrics": incoming_task_metrics,
                "timestamp": ts.isoformat(),
                "prolific": current_user.hit_id,
            }
            data.append(entry_data)
        else:
            entry_data["landmarks"] = landmarks
            entry_data["mode"] = mode
            prev_file_metrics = entry_data.get("task_metrics") if isinstance(entry_data.get("task_metrics"), dict) else {}
            entry_data["task_metrics"] = _merge_metrics(prev_file_metrics, incoming_task_metrics)
            entry_data["timestamp"] = ts.isoformat()

        with open(filename, "w") as f:
            json.dump(data, f, indent=2)

        return jsonify({"status": "ok"})
