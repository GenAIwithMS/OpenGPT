import logging
import os

import requests
from langchain_core.tools import tool

logger = logging.getLogger(__name__)

weather_api = os.getenv("WEATHER_API_KEY")
WEATHER_URL = "https://api.openweathermap.org/data/2.5/weather"


@tool
def Weather(city: str):
    """Use this tool to fetch the current weather conditions for any city. It provides real-time data including temperature, humidity, and a short description of the weather (e.g., clear sky, rain, snow)"""
    if not weather_api:
        return "The weather service is not configured."
    try:
        # params= URL-encodes the city; the key never appears in error text.
        resp = requests.get(
            WEATHER_URL,
            params={"q": city, "appid": weather_api, "units": "metric"},
            timeout=10,
        )
        data = resp.json()
    except Exception as e:
        logger.warning("Weather request failed: %s", type(e).__name__)
        return "The weather service could not be reached. Please try again later."

    if resp.status_code != 200:
        return f"Weather lookup failed: {data.get('message', 'unknown error')}."

    main = data.get("main", {})
    return {
        "city": data.get("name", city),
        "country": data.get("sys", {}).get("country"),
        "description": (data.get("weather") or [{}])[0].get("description"),
        "temperature_c": main.get("temp"),
        "feels_like_c": main.get("feels_like"),
        "humidity_percent": main.get("humidity"),
        "wind_speed_m_s": data.get("wind", {}).get("speed"),
    }
