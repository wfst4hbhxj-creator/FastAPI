from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from app.api.routes import stock
from app.core.config import settings

app = FastAPI(title=settings.app_name)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=200, # Telegram bot ignores 500, we return 200 with success=False
        content={"success": False, "error": str(exc)}
    )

@app.on_event("shutdown")
async def shutdown_event():
    await stock.close_resolver()

@app.get("/health")
async def health_check():
    return {"status": "ok"}

# Include routes
app.include_router(stock.router)
