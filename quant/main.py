from fastapi import FastAPI

app = FastAPI(title="Quant Service", version="0.1.0")


@app.get("/")
def root():
    return {"service": "quant", "status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok"}
