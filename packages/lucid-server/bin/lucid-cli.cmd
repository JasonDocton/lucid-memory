@echo off
if /I "%~1"=="update" goto update
bun run "%USERPROFILE%\.lucid\server\src\cli.ts" %*
exit /b %errorlevel%
:update
if exist "%USERPROFILE%\.lucid\server\src\upgrade.ts" (
    bun run --cwd "%USERPROFILE%\.lucid" --no-env-file --no-install "%USERPROFILE%\.lucid\server\src\upgrade.ts"
) else (
    bun run --cwd "%USERPROFILE%\.lucid" --no-env-file --no-install "%USERPROFILE%\.lucid\.upgrade-work\old\server\src\upgrade.ts"
)
exit /b %errorlevel%
