import os, base64
from flask import jsonify
from flask_login import login_required, current_user
from sqlalchemy import func
from src.models import db, Task, Response

NUM_TASKS_PER_BATCH = 6
def register_batch_routes(app):
    routes_data = app.extensions["routes_data"]

    def make_trajectory(t):
        images = [f"{image_filename}" for image_filename in routes_data[t.route_id]["observations"]]
        return {
            "task_id": t.id,
            "route_id": t.route_id,
            "map_url": f"{routes_data[t.route_id]['map']}",
            "images": images,
            "video": f"{t.route_id}.mp4",
            "landmarks": t.landmarks,
            "endpoint_order": t.endpoints,
        }

    @app.route("/next_batch")
    @login_required
    def next_batch():
        mode = app.config["APP_MODE"]

        # --- pick tasks ---
        if current_user.inflight_batch:
            tasks = db.session.query(Task).filter(Task.id.in_(current_user.last_batch)).all()
        else:
            subq = db.session.query(Response.task_id).filter_by(user_id=current_user.id)

            if mode == "draw":
                # draw study: pick routes user hasn't answered (same as your current logic)
                least_id_per_route = (
                    db.session.query(Task.route_id, func.max(Task.id).label("max_id"))
                    .filter(Task.served_count == 0)
                    .filter(~Task.id.in_(subq))
                    .group_by(Task.route_id)
                    .subquery()
                )
                tasks = (
                    Task.query
                    .join(least_id_per_route, Task.id == least_id_per_route.c.max_id)
                    .order_by(Task.route_id)
                    .limit(NUM_TASKS_PER_BATCH)
                    .all()
                )

            else:
                # landmark study: pick tasks that HAVE a drawing from someone (Response.drawing_path exists),
                # and that THIS user hasn't already landmarked.
                # This assumes a Response row exists when a drawing is saved.
                drawn_task_ids = (
                    db.session.query(Response.task_id)
                    .filter(Response.drawing_path.isnot(None))
                    .distinct()
                    .subquery()
                )
                tasks = (
                    Task.query
                    .filter(Task.id.in_(drawn_task_ids))
                    .filter(~Task.id.in_(subq))  # user hasn't responded to these tasks yet
                    .order_by(Task.route_id)
                    .limit(NUM_TASKS_PER_BATCH)
                    .all()
                )

            last_batch = [t.id for t in tasks]
            db.session.query(type(current_user)).filter_by(id=current_user.id).update({
                "last_batch": last_batch,
                "inflight_batch": True
            })
            db.session.commit()

        # --- saved answers payload ---
        saved = {}
        if mode == "draw":
            # send back any saved drawing for this user (optional)
            for r in Response.query.filter_by(user_id=current_user.id).filter(
                Response.task_id.in_([t.id for t in tasks]),
            ).all():
                drawing = None
                if r.drawing_path and os.path.exists(r.drawing_path):
                    with open(r.drawing_path, "rb") as f:
                        drawing_data = f.read()
                    drawing = f"data:image/png;base64,{base64.b64encode(drawing_data).decode('utf-8')}"
                saved[r.task_id] = {"drawing": drawing}
        else:
            # landmark app: you need a drawing to show (from *someone*). Return one drawing per task.
            # simplest: pick the most recent drawing for that task.
            for t in tasks:
                r = (
                    Response.query
                    .filter_by(task_id=t.id)
                    .filter(Response.drawing_path.isnot(None))
                    .order_by(Response.timestamp.desc())
                    .first()
                )
                drawing_url = None
                if r and r.drawing_path and os.path.exists(r.drawing_path):
                    fname = os.path.basename(r.drawing_path)
                    drawing_url = f"/user_drawings/{fname}"
                saved[t.id] = {"drawing_url": drawing_url}

        return jsonify({
            "trajectories": [make_trajectory(t) for t in tasks],
            "saved_answers": saved,
            "mode": mode,
        })