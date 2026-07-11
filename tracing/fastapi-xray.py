"""
AWS X-Ray tracing middleware for FastAPI + Python 3.14.

Install dependencies:
    pip install aws-xray-sdk

Usage in your FastAPI app (app/main.py):
    from tracing.fastapi_xray import configure_xray, xray_recorder

    app = FastAPI()
    configure_xray(app, service_name="my-api", environment=settings.ENVIRONMENT)

ECS task definition requirements (see aws/cdk/lib/xray-stack.ts):
  - X-Ray daemon sidecar container (XRayStack.addDaemonSidecar)
  - Environment variable: AWS_XRAY_DAEMON_ADDRESS=localhost:2000
"""

from __future__ import annotations

import os
from typing import Callable

from aws_xray_sdk.core import xray_recorder, patch_all
from aws_xray_sdk.core.context import Context
from aws_xray_sdk.ext.fastapi.middleware import XRayMiddleware
from fastapi import FastAPI, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp


# Re-export so callers can import the recorder directly from this module.
__all__ = [
    "configure_xray",
    "xray_recorder",
    "XRayAnnotationMiddleware",
    "capture_subsegment",
]

_HEALTH_CHECK_PATHS: frozenset[str] = frozenset({"/health", "/ready", "/metrics", "/livez", "/readyz"})


def configure_xray(
    app: FastAPI,
    *,
    service_name: str,
    environment: str | None = None,
    daemon_address: str | None = None,
    patch_libraries: bool = True,
    exclude_paths: frozenset[str] | None = None,
) -> None:
    """
    Configure AWS X-Ray and register tracing middleware on the FastAPI app.

    Args:
        app:             The FastAPI application instance.
        service_name:    Shown in the X-Ray service map; matches XRayStack serviceName.
        environment:     Annotation added to every segment (default: NODE_ENV or 'production').
        daemon_address:  X-Ray daemon host:port (default: AWS_XRAY_DAEMON_ADDRESS or localhost:2000).
        patch_libraries: Auto-patch boto3, requests, httpx, and SQLAlchemy (default: True).
        exclude_paths:   Paths that bypass tracing (default: health/readiness endpoints).
    """
    env = environment or os.environ.get("NODE_ENV", "production")
    address = daemon_address or os.environ.get("AWS_XRAY_DAEMON_ADDRESS", "localhost:2000")
    paths_to_exclude = exclude_paths if exclude_paths is not None else _HEALTH_CHECK_PATHS

    xray_recorder.configure(
        service=service_name,
        daemon_address=address,
        # In Lambda context_missing is RUNTIME_ERROR; elsewhere LOG_ERROR is safer.
        context_missing="LOG_ERROR",
        plugins=("ECSPlugin",),
        sampling=True,
    )

    if patch_libraries:
        # Patches: boto3, botocore, requests, httpx, sqlite3, pg8000, aiobotocore, etc.
        patch_all()

    # Core X-Ray segment open/close middleware (provided by aws-xray-sdk).
    app.add_middleware(XRayMiddleware, recorder=xray_recorder)

    # Annotation middleware adds environment/service labels to every segment so
    # the X-Ray group filter expression (see XRayStack) can match them.
    app.add_middleware(
        XRayAnnotationMiddleware,
        service_name=service_name,
        environment=env,
        exclude_paths=paths_to_exclude,
    )


class XRayAnnotationMiddleware(BaseHTTPMiddleware):
    """
    Adds standard annotations to every X-Ray segment so the service group
    filter expression `annotation.environment = "..." AND annotation.service = "..."`
    works correctly in the X-Ray console.

    This middleware must be added AFTER XRayMiddleware so the segment already
    exists when annotations are written (FastAPI processes middleware in reverse
    registration order — the last-added middleware wraps outermost).
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        service_name: str,
        environment: str,
        exclude_paths: frozenset[str],
    ) -> None:
        super().__init__(app)
        self._service_name = service_name
        self._environment = environment
        self._exclude_paths = exclude_paths

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if request.url.path in self._exclude_paths:
            return await call_next(request)

        segment = xray_recorder.current_segment()
        if segment is not None:
            segment.put_annotation("environment", self._environment)
            segment.put_annotation("service", self._service_name)
            segment.put_annotation("http_method", request.method)
            segment.put_annotation("http_path", request.url.path)
            segment.put_metadata(
                "request",
                {
                    "user_agent": request.headers.get("user-agent"),
                    "content_type": request.headers.get("content-type"),
                    "client_host": request.client.host if request.client else None,
                },
            )

        response = await call_next(request)

        if segment is not None:
            segment.put_annotation("http_status", response.status_code)
            if response.status_code >= 400:
                segment.error = True
            if response.status_code >= 500:
                segment.fault = True

        return response


def capture_subsegment(name: str):
    """
    Decorator / context manager that wraps a function in a named X-Ray subsegment.

    As a decorator:
        @capture_subsegment("fetch-user")
        async def get_user(user_id: str) -> User:
            ...

    As a context manager:
        with xray_recorder.in_subsegment("db-query") as sub:
            sub.put_annotation("table", "users")
            result = await db.execute(...)
    """
    import functools

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            with xray_recorder.in_subsegment(name):
                return await func(*args, **kwargs)

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            with xray_recorder.in_subsegment(name):
                return func(*args, **kwargs)

        import asyncio
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        return sync_wrapper

    return decorator


def capture_sqlalchemy(engine) -> None:
    """
    Patch a SQLAlchemy engine so all queries appear as X-Ray subsegments.

    Usage:
        from sqlalchemy.ext.asyncio import create_async_engine
        from tracing.fastapi_xray import capture_sqlalchemy

        engine = create_async_engine(settings.DATABASE_URL)
        capture_sqlalchemy(engine)
    """
    from aws_xray_sdk.ext.sqlalchemy.query import XRayMiddleware as SQLAlchemyXRay  # type: ignore[import]

    SQLAlchemyXRay(engine)
