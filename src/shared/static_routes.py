import os
from pathlib import Path
from flask import send_file, send_from_directory

APP_DIR = Path(__file__).resolve().parents[1]  # src/
MAPS_DIR = "/home/claireji/napkin-map/route_creation_jacob/maps/"
OBSERVATIONS_DIR = "/data/claireji/mapillary_jacob/mapillary/day2_seg13_images/"
VIDEO_DIR = "/data/claireji/mapillary_jacob/mapillary/videos/"
USER_DRAWINGS_DIR = (APP_DIR / ".." / "user_drawings").resolve()

def register_static_routes(app):

    @app.route("/videos/<path:filename>")
    def serve_video(filename):
        return send_from_directory(VIDEO_DIR, filename)

    @app.route("/maps/<path:fname>")
    def get_map(fname):
        return send_file(os.path.join(MAPS_DIR, fname))

    @app.route("/observations/<path:fname>")
    def get_image(fname):
        return send_file(os.path.join(OBSERVATIONS_DIR, fname))

    @app.route("/user_drawings/<path:fname>")
    def get_user_drawing(fname):
        return send_from_directory(USER_DRAWINGS_DIR, fname)