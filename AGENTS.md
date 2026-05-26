$caveman

## Test Deploy

Use this process when asked to deploy this web client to the local Jellyfin test backend:

1. Build web client from `C:\Users\INK\Desktop\jellyfin-web`:
   ```powershell
   npm run build:production
   ```

2. Build backend from `C:\Users\INK\Desktop\jellyfin`:
   ```powershell
   dotnet build Jellyfin.Server\Jellyfin.Server.csproj --configuration Debug
   ```

3. Prepare test backend data and initial test web directory:
   ```powershell
   & C:\jellyfin\prepare-test-backend.ps1 -CopyWebClient
   ```
   This creates/updates:
   - `C:\jellyfin-test-backend-data`
   - `C:\jellyfin-test-web`

4. Replace test web with current web build:
   ```powershell
   robocopy C:\Users\INK\Desktop\jellyfin-web\dist C:\jellyfin-test-web /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP
   ```
   Treat robocopy exit codes below 8 as success.

5. Stop currently running installed Jellyfin process:
   ```powershell
   Get-Process | Where-Object { $_.ProcessName -like '*jellyfin*' -or ($_.Path -and $_.Path -like 'C:\jellyfin\system\*') } | Stop-Process -Force
   ```

6. Start test backend from repo build with test data and test web:
   ```powershell
   Start-Process -FilePath dotnet `
     -ArgumentList @(
       'Jellyfin.Server\bin\Debug\net10.0\jellyfin.dll',
       '-d', 'C:\jellyfin-test-backend-data',
       '-w', 'C:\jellyfin-test-web',
       '--ffmpeg', 'C:\jellyfin\system\ffmpeg.exe'
     ) `
     -WorkingDirectory 'C:\Users\INK\Desktop\jellyfin' `
     -WindowStyle Hidden `
     -RedirectStandardOutput 'C:\jellyfin\start-test.out.log' `
     -RedirectStandardError 'C:\jellyfin\start-test.err.log'
   ```

7. Verify server:
   ```powershell
   Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8096/System/Info/Public'
   ```

Expected URL: `http://127.0.0.1:8096`.
Logs:
- `C:\jellyfin\start-test.out.log`
- `C:\jellyfin\start-test.err.log`

## Prod Web Deploy

Use this process when asked to deploy this web client to the actual local Jellyfin install:

1. Build web client from `C:\Users\INK\Desktop\jellyfin-web`:
   ```powershell
   npm run build:production
   ```

2. Mirror current web build into the installed Jellyfin web client directory:
   ```powershell
   robocopy C:\Users\INK\Desktop\jellyfin-web\dist C:\jellyfin\system\jellyfin-web /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP
   ```
   Treat robocopy exit codes below 8 as success.

3. Kill running Jellyfin instances after deploy:
   ```powershell
   Get-CimInstance Win32_Process | Where-Object {
       ($_.Name -like '*jellyfin*') -or
       ($_.ExecutablePath -and $_.ExecutablePath -like 'C:\jellyfin\system\*') -or
       ($_.CommandLine -and ($_.CommandLine -match 'Jellyfin\.Server\\bin\\Debug\\net10\.0\\jellyfin\.dll' -or $_.CommandLine -match 'C:\\jellyfin-test-backend-data'))
   } | ForEach-Object {
       Stop-Process -Id $_.ProcessId -Force
   }
   ```

Actual install web path: `C:\jellyfin\system\jellyfin-web`.
