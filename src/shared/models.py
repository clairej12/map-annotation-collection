from flask_sqlalchemy import SQLAlchemy
from flask_login    import UserMixin
from datetime       import datetime, timezone

db = SQLAlchemy()

class User(UserMixin, db.Model):
    id              = db.Column(db.Integer, primary_key=True)
    hit_id          = db.Column(db.String(128), unique=True, index=True, nullable=False)
    # prolific fields
    prolific_pid = db.Column(db.String(64), index=True)
    prolific_study_id = db.Column(db.String(64), index=True)
    prolific_session_id = db.Column(db.String(64), index=True)
    email           = db.Column(db.String(256), unique=True, nullable=True) # TODO figure out what we can actually collect from Turkers
    created_at      = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_batch      = db.Column(db.JSON, default=list)
    inflight_batch  = db.Column(db.Boolean, default=False)
    passed_quiz     = db.Column(db.Boolean, default=False)

    responses   = db.relationship("Response", backref="user", lazy=True)

class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    route_id = db.Column(db.String, unique=True, index=True, nullable=False)
    served_count   = db.Column(db.Integer, default=0)
    landmarks     = db.Column(db.JSON, default=list)
    endpoints     = db.Column(db.JSON, default=list)

    responses      = db.relationship("Response", backref="task", lazy=True)

class Drawing(db.Model):
    id              = db.Column(db.Integer, primary_key=True)
    user_id         = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    task_id         = db.Column(db.Integer, db.ForeignKey("task.id"), nullable=False)
    drawing_path    = db.Column(db.Text, nullable=True)
    metrics_json = db.Column(db.Text, nullable=True)
    timestamp       = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

class Landmark(db.Model):
    id              = db.Column(db.Integer, primary_key=True)
    user_id         = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    task_id         = db.Column(db.Integer, db.ForeignKey("task.id"), nullable=False)
    landmarks       = db.Column(db.JSON, default=list)
    metrics_json = db.Column(db.Text, nullable=True)
    timestamp       = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
