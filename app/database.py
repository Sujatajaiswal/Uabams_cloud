import os
from functools import lru_cache
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from app.db_wrapper import DatabaseWrapper

load_dotenv()


@lru_cache
def get_settings() -> dict[str, str]:
    db_url = os.getenv("DATABASE_URL", "")
    default_db_type = "postgres" if db_url else "mongodb"
    return {
        "mongodb_url": os.getenv("MONGODB_URL", "mongodb://localhost:27017"),
        "database_name": os.getenv("DATABASE_NAME", "uabams_db"),
        "database_type": os.getenv("DATABASE_TYPE", default_db_type),
        "database_url": db_url,
        "jwt_secret": os.getenv("JWT_SECRET", "change-this-secret"),
        "jwt_algorithm": os.getenv("JWT_ALGORITHM", "HS256"),
        "admin_reset_key": os.getenv("ADMIN_RESET_KEY", ""),
        "admin_username": os.getenv("ADMIN_USERNAME", "admin"),
        "admin_password": os.getenv("ADMIN_PASSWORD", "admin123"),
        "operator_username": os.getenv("OPERATOR_USERNAME", "operator"),
        "operator_password": os.getenv("OPERATOR_PASSWORD", "operator123"),
    }


settings = get_settings()

motor_client = None
motor_db = None

if settings["database_type"] == "mongodb":
    motor_client = AsyncIOMotorClient(settings["mongodb_url"])
    motor_db = motor_client[settings["database_name"]]

db = DatabaseWrapper(settings["database_type"], motor_db=motor_db, pg_pool=None)


