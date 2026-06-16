@echo off
:: 设置 Maven 的绝对路径
:: 如果不确定，可以在 CMD 里输入 where mvn 查看
set MAVEN_HOME=C:\ses_dev\tools\apache-maven-3.6.3
set MVN_CMD=%MAVEN_HOME%\bin\mvn.cmd

:: 检查 Maven 是否存在
if not exist "%MVN_CMD%" (
    echo [错误] 找不到 Maven: %MVN_CMD%
    echo 请检查脚本里的 MAVEN_HOME 设置，或者确保系统 Path 里配置了 Maven。
    pause
    exit /b
)

echo 开始批量构建 Maven 项目...
echo 使用 Maven: %MVN_CMD%
echo.

set LOG_FILE=build_result_summary.txt
echo === 构建结果总结 (%date% %time%) === > "%LOG_FILE%"

:: 遍历当前文件夹下的所有子文件夹
for /d %%D in (*) do (
    :: 检查里面有没有 pom.xml
    if exist "%%D\pom.xml" (
        echo 正在构建: %%D ...
        
        :: 进入目录
        pushd "%%D"
        
        :: 执行构建，输出到根目录的临时文件，避免子目录乱
        :: 注意：这里用 call 或者直接调用绝对路径
        "%MVN_CMD%" clean install > "..\temp_build.log" 2>&1
        
        :: 检查执行结果
        if errorlevel 1 (
            echo [ 构建失败] %%D >> "..\%LOG_FILE%"
            echo --- 失败详情 --- >> "..\%LOG_FILE%"
            type "..\temp_build.log" >> "..\%LOG_FILE%"
            echo ==================== >> "..\%LOG_FILE%"
            echo   -> 失败！(详见日志)
        ) else (
            echo [✅ 构建成功] %%D >> "..\%LOG_FILE%"
            echo   -> 成功
        )
        
        :: 清理临时文件
        del "..\temp_build.log"
        
        :: 返回上一级
        popd
    )
)

echo.
echo ==========================================
echo 全部完成！
echo 请查看当前目录下的 %LOG_FILE% 文件。
echo ==========================================
pause






























