import httpx
import base64
import os
import logging
import re
from datetime import datetime
from typing import List, Dict, Optional
import uuid

# Setup logging
logger = logging.getLogger(__name__)


async def generate_images(settings: Dict, prompt: str, n: int, image_data: Optional[str] = None) -> List[str]:
    """
    Call external image generation API and save images

    Args:
        settings: Dict with base_url, api_key, model, proxy (optional)
        prompt: Text prompt for image generation
        n: Number of images to generate

    Returns:
        List of saved filenames
    """
    base_url = settings["base_url"].rstrip("/")
    api_key = settings["api_key"]
    model = settings["model"]
    proxy = settings.get("proxy")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }

    # Choose endpoint based on whether image_data is provided
    if image_data:
        # Use chat completions endpoint for img2img
        url = f"{base_url}/v1/chat/completions"
        payload = {
            "model": model,
            "temperature": 1,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data}}
                ]
            }],
            "stream": False  # 使用非流式响应以便解析
        }
    else:
        # Use standard images/generations endpoint
        url = f"{base_url}/v1/images/generations"
        payload = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "stream": False,
            "size": "1024x1024",
            "quality": "standard",
            "response_format": "b64_json"  # Try b64_json first
        }

    filenames = []

    # Configure proxy if provided
    client_kwargs = {"timeout": 300.0}
    if proxy:
        logger.info(f"Using proxy: {proxy}")
        client_kwargs["proxy"] = proxy

    async with httpx.AsyncClient(**client_kwargs) as client:
        try:
            logger.info(f"Generating {n} images with prompt: {prompt[:50]}... (img2img: {image_data is not None})")
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()

            # Handle img2img response (chat completions)
            if image_data:
                content = data["choices"][0]["message"]["content"]

                # Extract all URLs (handle both plain URL and markdown format)
                url_matches = re.findall(r'https?://[^\s\)]+', content)
                if url_matches:
                    # Convert to list of dicts for _save_url_images
                    image_urls = [{"url": url} for url in url_matches]
                    # Reuse existing _save_url_images function
                    filenames = await _save_url_images(image_urls, prompt, client)
                    logger.info(f"Successfully saved {len(filenames)} images (img2img)")
                else:
                    raise ValueError("No valid image URL in response")

            # Handle standard text-to-image response
            elif "data" in data and len(data["data"]) > 0:
                if "b64_json" in data["data"][0]:
                    filenames = await _save_b64_images(data["data"], prompt)
                    logger.info(f"Successfully saved {len(filenames)} images (b64_json)")
                elif "url" in data["data"][0]:
                    filenames = await _save_url_images(data["data"], prompt, client)
                    logger.info(f"Successfully saved {len(filenames)} images (url)")
                else:
                    raise ValueError("Unknown response format")
            else:
                raise ValueError("No image data in response")

        except (httpx.HTTPStatusError, KeyError) as e:
            # Only try fallback for text-to-image (not img2img)
            if not image_data:
                logger.warning(f"b64_json format failed, trying url format: {e}")
                # Fallback to url format
                payload["response_format"] = "url"

                try:
                    response = await client.post(url, json=payload, headers=headers)
                    response.raise_for_status()
                    data = response.json()

                    if "data" in data and len(data["data"]) > 0:
                        if "url" in data["data"][0]:
                            filenames = await _save_url_images(data["data"], prompt, client)
                            logger.info(f"Successfully saved {len(filenames)} images (url fallback)")
                        else:
                            raise ValueError("No valid image data in response")
                    else:
                        raise ValueError("Empty response data")
                except Exception as fallback_error:
                    logger.error(f"Both b64_json and url formats failed: {fallback_error}")
                    raise
            else:
                logger.error(f"Image generation failed (img2img): {e}")
                raise

        except Exception as e:
            logger.error(f"Image generation failed: {e}")
            raise

    return filenames


async def _save_b64_images(data: List[Dict], prompt: str) -> List[str]:
    """Save images from base64 encoded data"""
    os.makedirs("output", exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    short_id = str(uuid.uuid4())[:8]

    filenames = []

    for idx, item in enumerate(data, 1):
        try:
            b64_data = item["b64_json"]
            image_bytes = base64.b64decode(b64_data)

            # Sanitize filename to prevent path traversal
            filename = f"{timestamp}_{short_id}_{idx}.png"
            filepath = os.path.join("output", filename)

            # Ensure the path is within output directory
            if not os.path.abspath(filepath).startswith(os.path.abspath("output")):
                raise ValueError("Invalid file path")

            with open(filepath, "wb") as f:
                f.write(image_bytes)

            filenames.append(filename)
            logger.debug(f"Saved image: {filename}")

        except Exception as e:
            logger.error(f"Failed to save image {idx}: {e}")
            raise

    return filenames


async def _save_url_images(data: List[Dict], prompt: str, client: httpx.AsyncClient) -> List[str]:
    """Download and save images from URLs"""
    os.makedirs("output", exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    short_id = str(uuid.uuid4())[:8]

    filenames = []

    for idx, item in enumerate(data, 1):
        try:
            image_url = item["url"]

            # Download image
            logger.debug(f"Downloading image from: {image_url}")
            response = await client.get(image_url)
            response.raise_for_status()
            image_bytes = response.content

            # Determine file extension from content-type or URL
            content_type = response.headers.get("content-type", "")
            if "jpeg" in content_type or "jpg" in content_type or image_url.endswith(".jpg"):
                ext = "jpg"
            elif "png" in content_type or image_url.endswith(".png"):
                ext = "png"
            else:
                ext = "jpg"  # default

            # Sanitize filename to prevent path traversal
            filename = f"{timestamp}_{short_id}_{idx}.{ext}"
            filepath = os.path.join("output", filename)

            # Ensure the path is within output directory
            if not os.path.abspath(filepath).startswith(os.path.abspath("output")):
                raise ValueError("Invalid file path")

            with open(filepath, "wb") as f:
                f.write(image_bytes)

            filenames.append(filename)
            logger.debug(f"Saved image: {filename}")

        except Exception as e:
            logger.error(f"Failed to download/save image {idx}: {e}")
            raise

    return filenames
