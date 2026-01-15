from datetime import datetime, timezone
from flask import request, redirect, url_for, jsonify, session, render_template
from flask_login import login_user, login_required, current_user, logout_user
from src.models import db, User

def register_shared_routes(app):

    def _get_param(name):
        return request.args.get(name) or request.form.get(name)

    @app.route("/prolific", methods=["GET"])
    def prolific_entry():
        prolific_pid = _get_param("PROLIFIC_PID")
        prolific_study_id = _get_param("STUDY_ID")
        prolific_session_id = _get_param("SESSION_ID")

        if not prolific_pid:
            return "Missing PROLIFIC_PID", 400

        internal_hit_id = f"{prolific_pid}_{prolific_session_id}_{prolific_study_id}"

        user = User.query.filter_by(hit_id=internal_hit_id).first()
        if not user:
            user = User(hit_id=internal_hit_id)

        user.prolific_pid = prolific_pid
        user.prolific_study_id = prolific_study_id
        user.prolific_session_id = prolific_session_id
        user.last_seen_at = datetime.now(timezone.utc)

        db.session.add(user)
        db.session.commit()

        session["prolific_pid"] = prolific_pid
        session["prolific_study_id"] = prolific_study_id
        session["prolific_session_id"] = prolific_session_id
        session["user_id"] = f"{prolific_pid}_{prolific_session_id}"
        session["study_id"] = prolific_study_id

        login_user(user)

        # IMPORTANT: each app has its own landing route name
        if app.config["APP_MODE"] == "draw":
            return redirect(url_for("draw_survey"))
        else:
            return redirect(url_for("landmark_survey"))

    @app.get("/api/whoami")
    @login_required
    def whoami():
        return {
            "prolific_pid": session.get("prolific_pid"),
            "prolific_study_id": session.get("prolific_study_id"),
            "prolific_session_id": session.get("prolific_session_id"),
            "user_id": session.get("user_id"),
            "app_mode": app.config.get("APP_MODE"),
        }

    @app.route("/login_page", methods=["GET"])
    def login_page():
        return render_template("login.html")

    @app.route("/authenticate", methods=["POST"])
    def authenticate():
        payload = request.get_json() or {}
        user_id = payload.get("user_id")
        study_id = payload.get("study_id")

        HARDCODED_STUDY_ID = "ClaireTest123"
        if study_id != HARDCODED_STUDY_ID:
            return jsonify({"status": "error", "message": "Invalid study ID"}), 403
        if not user_id:
            return jsonify({"status": "error", "message": "Missing user ID"}), 400

        user = User.query.filter_by(hit_id=user_id).first()
        if not user:
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
        return jsonify({"status": "ok", "completion_url": completion_url})