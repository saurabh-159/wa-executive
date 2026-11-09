from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_NAME: str = "WhatsApp Executive Assistant AI"
    DEBUG: bool = True
    DATABASE_URL: str = "sqlite:///./assistant.db"
    OPENAI_API_KEY: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
    )


settings = Settings()
