@echo off
chcp 65001
set MVN=C:\ses_dev\tools\apache-maven-3.6.3\bin\mvn.cmd
set LOG=build_result.txt

echo Starting build... > %LOG%

for /d %%i in (*) do (
    if exist "%%i\pom.xml" (
        echo Building %%i ...
        cd %%i
        call %MVN% clean install -q
        if errorlevel 1 (
            echo FAILED: %%i >> ..\%LOG%
        ) else (
            echo OK: %%i >> ..\%LOG%
        )
        cd ..
    )
)

echo Done! Check %LOG%
pause