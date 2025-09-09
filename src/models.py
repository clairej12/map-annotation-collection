from flask_sqlalchemy import SQLAlchemy
from flask_login    import UserMixin
from datetime       import datetime, timezone

db = SQLAlchemy()

class User(UserMixin, db.Model):
    id              = db.Column(db.Integer, primary_key=True)
    hit_id          = db.Column(db.String(256), unique=True, nullable=False)
    email           = db.Column(db.String(256), unique=True, nullable=True) # TODO figure out what we can actually collect from Turkers
    created_at      = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_batch      = db.Column(db.JSON, default=list)
    inflight_batch  = db.Column(db.Boolean, default=False)
    passed_quiz     = db.Column(db.Boolean, default=False)

    responses   = db.relationship("Response", backref="user", lazy=True)

class Task(db.Model):
    id             = db.Column(db.Integer, primary_key=True)
    route_id       = db.Column(db.Integer, nullable=False)
    served_count   = db.Column(db.Integer, default=0)
    landmarks     = db.Column(db.JSON, default=list)

    responses      = db.relationship("Response", backref="task", lazy=True)

class Response(db.Model):
    id              = db.Column(db.Integer, primary_key=True)
    user_id         = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    task_id         = db.Column(db.Integer, db.ForeignKey("task.id"), nullable=False)
    landmarks       = db.Column(db.JSON, default=list)
    drawing_path    = db.Column(db.Text, nullable=True)
    duration        = db.Column(db.Float, nullable=False)
    clickCounts     = db.Column(db.JSON, default=dict)
    timestamp       = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
