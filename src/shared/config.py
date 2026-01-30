import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY      = os.getenv("SECRET_KEY", "change-me")
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL", "sqlite:///mapdatacollection.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    MAX_CONCURRENT_USERS = int(os.getenv("MAX_CONCURRENT_USERS", "0"))  # 0 = no limit

    # Google OAuth2
    OAUTH_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID")
    OAUTH_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
    OAUTH_REDIRECT_URI  = os.getenv("OAUTH_REDIRECT_URI", "http://e1-056063.science.psu.edu:5000/oauth2callback")
