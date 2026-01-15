from src.common.factory import create_app
from src.common.shared_routes import register_shared_routes
from src.common.static_routes import register_static_routes
from src.common.batch_routes import register_batch_routes

from flask import render_template, session
from flask_login import login_required

# bring in your existing save_landmarks (and optionally check_quiz)
from src.landmark_endpoints import register_landmark_endpoints

app = create_app("landmarks")
register_shared_routes(app)
register_static_routes(app)
register_batch_routes(app)
register_landmark_endpoints(app)

@app.route("/")
@login_required
def landmark_survey():
    return render_template(
        "landmark_survey.html",
        user_id=session.get("user_id", ""),
        study_id=session.get("study_id", "")
    )