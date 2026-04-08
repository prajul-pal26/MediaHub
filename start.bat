@echo off
REM ==========================================
REM  MediaHub — One-Command Start (Windows)
REM ==========================================
REM  Usage: start.bat           (keep data between restarts)
REM         start.bat --reset   (wipe everything, fresh start)
REM  Requirements: Docker Desktop + Git

echo.
echo ==========================================
echo   MediaHub — Starting
echo ==========================================
echo.

REM ─── Check Docker ───
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not running.
    echo Install/start Docker Desktop: https://docs.docker.com/get-docker/
    exit /b 1
)
echo [1/4] Docker OK

REM ─── Handle --reset flag ───
if "%1"=="--reset" (
    echo.
    echo [2/4] Resetting — removing all containers and data...
    docker compose down -v >nul 2>&1
    docker builder prune -f >nul 2>&1
    echo   Clean slate ready.
) else (
    echo.
    echo [2/4] Stopping any existing containers...
    docker compose down >nul 2>&1
)

REM ─── Pull latest code ───
echo.
echo [3/4] Checking for code updates...
git rev-parse --git-dir >nul 2>&1
if not errorlevel 1 (
    git fetch origin >nul 2>&1
    git diff --quiet >nul 2>&1
    if not errorlevel 1 (
        git diff --cached --quiet >nul 2>&1
        if not errorlevel 1 (
            echo   Pulling latest code...
            git pull
        ) else (
            echo   You have staged changes — skipping pull.
        )
    ) else (
        echo   You have local changes — skipping pull.
    )
) else (
    echo   No git repo — skipping update check.
)

REM ─── Build and start ───
echo.
echo [4/4] Building and starting all services...
echo.
docker compose up -d --build

echo.
echo ==========================================
echo   MediaHub is running!
echo ==========================================
echo.
echo   App (HTTPS): https://localhost:3443
echo   App (HTTP):  http://localhost:3000
echo   Studio:      http://localhost:54323
echo   Email:       http://localhost:54324
echo.
echo   First-time login: admin@mediahub.local / admin123
echo.
echo   View logs:   docker compose logs -f app worker
echo   Stop:        docker compose down
echo   Full reset:  start.bat --reset
echo.
