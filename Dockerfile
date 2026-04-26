FROM python:3.11-slim

WORKDIR /app

COPY . /app

RUN pip install --upgrade pip && pip install -e ".[webapp]"

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "llmSHAP.webapp.app:app", "--host", "0.0.0.0", "--port", "8000"]
