import httpx
import base64
import os
import logging
import re
import traceback
import asyncio
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
                    raise ValueError("No valid image URL in response, content=" + content)

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

        except httpx.HTTPStatusError as e:
            # Extract error details from response body
            error_msg = f"HTTP {e.response.status_code}"
            try:
                error_body = e.response.text
                if error_body:
                    # Try to parse as JSON for better formatting
                    if "error" not in error_body:
                        error_msg += f" - Response body: {error_body}"
                    else:
                        try:
                            error_json = e.response.json()
                            if "error" in error_json:
                                error_msg += f" - Error: {error_json['error']}"
                        except:
                            error_msg += f" - Response body: {error_body}"
            except:
                pass

            logger.error(f"API request failed: {error_msg}", exc_info=True)

            # Only try fallback for text-to-image (not img2img)
            if not image_data:
                logger.warning(f"b64_json format failed, trying url format")
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
                except httpx.HTTPStatusError as fallback_http_error:
                    # Extract error details from fallback response
                    fallback_error_msg = f"HTTP {fallback_http_error.response.status_code}"
                    try:
                        fallback_error_body = fallback_http_error.response.text
                        if fallback_error_body:
                            fallback_error_msg += f" - Response body: {fallback_error_body}"
                    except:
                        pass
                    logger.error(f"Both b64_json and url formats failed: {fallback_error_msg}", exc_info=True)
                    raise ValueError(f"Image generation failed: {fallback_error_msg}") from fallback_http_error
                except Exception as fallback_error:
                    logger.error(f"Both b64_json and url formats failed: {fallback_error}", exc_info=True)
                    raise
            else:
                raise ValueError(f"Image generation failed (img2img): {error_msg}") from e

        except KeyError as e:
            logger.error(f"Response parsing failed: {e}", exc_info=True)
            raise ValueError(f"Invalid response format: {e}") from e

        except Exception as e:
            logger.error(f"Image generation failed: {e}", exc_info=True)
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
            logger.error(f"Failed to save image {idx}: {e}", exc_info=True)
            raise

    return filenames


async def _download_single_image(
    client: httpx.AsyncClient,
    image_url: str,
    idx: int,
    timestamp: str,
    short_id: str,
    max_retries: int = 3
) -> str:
    """Download a single image with retry logic"""
    for attempt in range(1, max_retries + 1):
        try:
            logger.debug(f"Downloading image {idx} from: {image_url} (attempt {attempt}/{max_retries})")
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

            logger.debug(f"Saved image: {filename}")
            return filename

        except Exception as e:
            if attempt < max_retries:
                logger.warning(f"Failed to download image {idx} (attempt {attempt}/{max_retries}): {e}, retrying in 1 second...")
                await asyncio.sleep(1)
            else:
                logger.error(f"Failed to download/save image {idx} after {max_retries} attempts: {e}", exc_info=True)
                raise


async def _save_url_images(data: List[Dict], prompt: str, client: httpx.AsyncClient, max_concurrent: int = 2) -> List[str]:
    """Download and save images from URLs with concurrent downloads and retry logic"""
    os.makedirs("output", exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    short_id = str(uuid.uuid4())[:8]

    # Create semaphore to limit concurrent downloads
    semaphore = asyncio.Semaphore(max_concurrent)

    async def download_with_semaphore(item: Dict, idx: int) -> str:
        async with semaphore:
            image_url = item["url"]
            return await _download_single_image(client, image_url, idx, timestamp, short_id)

    # Create download tasks for all images
    tasks = [download_with_semaphore(item, idx) for idx, item in enumerate(data, 1)]

    # Execute all downloads concurrently (limited by semaphore)
    filenames = await asyncio.gather(*tasks)

    return list(filenames)
