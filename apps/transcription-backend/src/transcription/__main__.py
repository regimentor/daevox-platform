import json
import logging
import sys

import uvicorn

from .api import create_app
from .config import Settings


class JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps(
            {
                "level": record.levelname,
                "event": record.getMessage(),
                "operation_id": getattr(record, "operation_id", None),
                "stage": getattr(record, "stage", None),
                "code": getattr(record, "code", None),
            }
        )


def main():
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(handlers=[handler], level=logging.INFO)
    settings = Settings()
    uvicorn.run(
        create_app(settings), host=settings.host, port=settings.port, workers=1, access_log=False
    )


if __name__ == "__main__":
    main()
