import os
from functools import lru_cache

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()


@lru_cache
def get_settings() -> dict[str, str]:
    return {
        "mongodb_url": os.getenv("MONGODB_URL", "mongodb://localhost:27017"),
        "database_name": os.getenv("DATABASE_NAME", "uabams_db"),
        "jwt_secret": os.getenv("JWT_SECRET", "change-this-secret"),
        "jwt_algorithm": os.getenv("JWT_ALGORITHM", "HS256"),
        "admin_reset_key": os.getenv("ADMIN_RESET_KEY", ""),
    }


settings = get_settings()
client = AsyncIOMotorClient(settings["mongodb_url"])
db = client[settings["database_name"]]

