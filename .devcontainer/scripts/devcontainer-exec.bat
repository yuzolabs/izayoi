@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORKSPACE_PATH=%CD%"
set "COMMAND_TEXT=bash"

:parse_args
if "%~1"=="" goto after_args
if /I "%~1"=="-WorkspacePath" (
    if "%~2"=="" (
        echo [ERROR] -WorkspacePath requires a value.
        exit /b 1
    )
    set "WORKSPACE_PATH=%~2"
    shift
    shift
    goto parse_args
)
if /I "%~1"=="-Command" (
    if "%~2"=="" (
        echo [ERROR] -Command requires a value.
        exit /b 1
    )
    set "COMMAND_TEXT=%~2"
    shift
    shift
    goto parse_args
)

echo [ERROR] Unknown argument: %~1
exit /b 1

:after_args
for %%I in ("%WORKSPACE_PATH%") do set "WORKSPACE_PATH=%%~fI"
echo [INFO] Workspace: %WORKSPACE_PATH%

for %%I in ("%WORKSPACE_PATH%") do set "WORKSPACE_NAME=%%~nxI"
echo [INFO] Workspace name: %WORKSPACE_NAME%

where wsl >nul 2>&1
if errorlevel 1 (
    echo [ERROR] WSL2 not found. DevContainer requires WSL2.
    echo [INFO] Please install WSL2 and Docker Desktop.
    echo [INFO] Alternatively, use VS Code 'Reopen in Container' feature.
    exit /b 1
)

wsl --status >nul 2>&1
if errorlevel 1 (
    echo [ERROR] WSL2 is not properly configured.
    echo [INFO] Please run 'wsl --install' to set up WSL2.
    exit /b 1
)

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$p=(Resolve-Path '%WORKSPACE_PATH%').Path; $n=$p -replace '\\','/'; if($n -match '^([A-Za-z]):/(.*)$'){ '/mnt/' + $matches[1].ToLower() + '/' + $matches[2] } else { $n }"`) do set "WSL_WORKSPACE_PATH=%%I"
if not defined WSL_WORKSPACE_PATH (
    echo [ERROR] Failed to convert workspace path for WSL.
    exit /b 1
)

set "INIT_SCRIPT=%WSL_WORKSPACE_PATH%/.devcontainer/host-initialize.sh"
echo [INFO] Initializing DevContainer configuration...
wsl bash -c "if [ -f '%INIT_SCRIPT%' ]; then bash '%INIT_SCRIPT%' '%WSL_WORKSPACE_PATH%' '%WORKSPACE_NAME%' '/workspaces/my-repository-template' '/workspace'; else echo 'host-initialize.sh not found, skipping initialization'; fi"
if errorlevel 1 (
    echo [WARNING] Initialization script failed, but continuing...
)

call :repair_git_file

call :is_interactive "%COMMAND_TEXT%"
set "IS_INTERACTIVE=%ERRORLEVEL%"

set "INITIAL_COMMAND=%COMMAND_TEXT%"
if "%IS_INTERACTIVE%"=="0" set "INITIAL_COMMAND=true"

call :run_wsl_capture "%INITIAL_COMMAND%"
set "EXEC_EXIT_CODE=!RUN_EXIT_CODE!"

if not "!EXEC_EXIT_CODE!"=="0" (
    findstr /I /C:"Dev container not found" /C:"Container not found" /C:"Shell server terminated" /C:"is not running" "!RUN_OUTPUT_FILE!" >nul 2>&1
    if not errorlevel 1 (
        echo [WARNING] Dev container is unavailable. Starting container...
        call :start_container
        if errorlevel 1 exit /b %ERRORLEVEL%
        echo [INFO] Container started. Retrying exec command...
        call :run_wsl_capture "%INITIAL_COMMAND%"
        set "EXEC_EXIT_CODE=!RUN_EXIT_CODE!"
    )
)

if "%IS_INTERACTIVE%"=="0" goto interactive_wsl

type "!RUN_OUTPUT_FILE!"
if not "!EXEC_EXIT_CODE!"=="0" (
    echo [ERROR] Command execution failed ^(exit code: !EXEC_EXIT_CODE!^)
    del "!RUN_OUTPUT_FILE!" >nul 2>&1
    exit /b !EXEC_EXIT_CODE!
)
del "!RUN_OUTPUT_FILE!" >nul 2>&1
exit /b 0

:interactive_wsl
if exist "!RUN_OUTPUT_FILE!" del "!RUN_OUTPUT_FILE!" >nul 2>&1
echo [INFO] Entering interactive shell. Type 'exit' to return to Command Prompt.
echo [INFO] Running interactive shell via WSL2...
echo Execute: wsl devcontainer exec --workspace-folder "%WSL_WORKSPACE_PATH%" bash
wsl devcontainer exec --workspace-folder "%WSL_WORKSPACE_PATH%" bash
exit /b %ERRORLEVEL%

:run_wsl_capture
set "RUN_OUTPUT_FILE=%TEMP%\devcontainer-exec-%RANDOM%%RANDOM%.log"
echo [INFO] Running via WSL2...
echo Execute: wsl devcontainer exec --workspace-folder "%WSL_WORKSPACE_PATH%" bash -lc "%~1"
wsl devcontainer exec --workspace-folder "%WSL_WORKSPACE_PATH%" bash -lc "%~1" >"%RUN_OUTPUT_FILE%" 2>&1
set "RUN_EXIT_CODE=%ERRORLEVEL%"
exit /b 0

:start_container
echo [INFO] Starting DevContainer...

wsl bash -c "command -v devcontainer" >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing DevContainer CLI in WSL2...
    wsl bash -c "npm install -g @devcontainers/cli"
    if errorlevel 1 (
        echo [ERROR] Failed to install DevContainer CLI
        exit /b 1
    )
)

wsl docker version --format '{{.Server.Version}}' >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not running. Please start Docker Desktop.
    exit /b 1
)

rem GH_TOKENの取得（環境変数優先、未設定ならgh auth tokenを実行）
echo [INFO] Checking GitHub token...
set "GH_TOKEN_VALUE="
if defined GH_TOKEN (
    set "GH_TOKEN_VALUE=%GH_TOKEN%"
    echo [INFO] Using GH_TOKEN from environment variable.
) else (
    echo [INFO] GH_TOKEN not set. Attempting to retrieve token via 'gh auth token' in WSL2...
    for /f "usebackq delims=" %%I in (`wsl bash -c "gh auth token 2>/dev/null || echo __GH_TOKEN_NOT_FOUND__"`) do set "GH_TOKEN_RESULT=%%I"
    if "!GH_TOKEN_RESULT!"=="__GH_TOKEN_NOT_FOUND__" (
        echo [WARNING] Failed to retrieve token from 'gh auth token'. GitHub CLI may not be authenticated.
    ) else if "!GH_TOKEN_RESULT!"=="" (
        echo [WARNING] 'gh auth token' returned empty. GitHub CLI may not be authenticated.
    ) else (
        set "GH_TOKEN_VALUE=!GH_TOKEN_RESULT!"
        echo [INFO] Successfully retrieved token from 'gh auth token'.
    )
)

echo [INFO] Running devcontainer up...
if defined GH_TOKEN_VALUE (
    echo Execute: wsl devcontainer up --workspace-folder "%WSL_WORKSPACE_PATH%" with GH_TOKEN
    set "WSLENV=GH_TOKEN/u"
    set "GH_TOKEN=!GH_TOKEN_VALUE!"
    wsl devcontainer up --workspace-folder "%WSL_WORKSPACE_PATH%"
) else (
    echo Execute: wsl devcontainer up --workspace-folder "%WSL_WORKSPACE_PATH%"
    wsl devcontainer up --workspace-folder "%WSL_WORKSPACE_PATH%"
)
if errorlevel 1 (
    echo [ERROR] Failed to start DevContainer
    exit /b 1
)
echo [INFO] Container started successfully
exit /b 0

:is_interactive
if /I "%~1"=="bash" exit /b 0
if /I "%~1"=="bash -i" exit /b 0
if /I "%~1"=="bash -l" exit /b 0
if /I "%~1"=="sh" exit /b 0
if /I "%~1"=="sh -i" exit /b 0
if /I "%~1"=="sh -l" exit /b 0
if /I "%~1"=="zsh" exit /b 0
if /I "%~1"=="zsh -i" exit /b 0
if /I "%~1"=="zsh -l" exit /b 0
exit /b 1

:repair_git_file
set "GIT_FILE=%WORKSPACE_PATH%\.git"
if not exist "%GIT_FILE%" exit /b 0
if exist "%GIT_FILE%\*" exit /b 0

for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "Get-Content '%GIT_FILE%' -Raw"`) do set "GIT_CONTENT=%%A"

echo !GIT_CONTENT! | findstr /B "gitdir: /mnt/" >nul 2>&1
if errorlevel 1 exit /b 0

echo [INFO] Repairing .git file ^(converting WSL path to Windows path^)...

for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$content = Get-Content '%GIT_FILE%' -Raw; if ($content -match '^gitdir: /mnt/([a-z])/(.*)$') { $drive = $matches[1].ToUpper(); 'gitdir: ' + $drive + ':/' + $matches[2] } else { $content }"`) do set "REPAIRED_CONTENT=%%A"

powershell -NoProfile -Command "Set-Content -Path '%GIT_FILE%' -Value '%REPAIRED_CONTENT%' -NoNewline"
echo [INFO] .git file repaired: %REPAIRED_CONTENT%
exit /b 0
