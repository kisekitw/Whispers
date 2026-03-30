# deploy.ps1 — 從 .env.deploy 讀取設定並部署到 Cloud Run

$ErrorActionPreference = "Stop"

# 讀取 .env.deploy
$envVars = @{}
Get-Content ".env.deploy" | ForEach-Object {
    if ($_ -match "^([^#\s][^=]*)=(.*)$") {
        $envVars[$matches[1].Trim()] = $matches[2].Trim()
    }
}

$project = $envVars["GCLOUD_PROJECT"]
$region  = $envVars["GCLOUD_REGION"]
$service = $envVars["GCLOUD_SERVICE"]

$envString = (
    "GEMINI_API_KEY=$($envVars['GEMINI_API_KEY'])",
    "LINE_CHANNEL_ID=$($envVars['LINE_CHANNEL_ID'])",
    "LINE_CHANNEL_SECRET=$($envVars['LINE_CHANNEL_SECRET'])",
    "LINE_CHANNEL_ACCESS_TOKEN=$($envVars['LINE_CHANNEL_ACCESS_TOKEN'])"
) -join ","

Write-Host "[Deploy] $service ($region / $project)"

gcloud run deploy $service `
    --source . `
    --region $region `
    --project $project `
    --set-env-vars $envString `
    --quiet

Write-Host "[Done] Deploy complete."
