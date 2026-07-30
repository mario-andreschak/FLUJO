param(
  [Parameter(Mandatory = $true)]
  [string]$VoiceKey,

  [Parameter(Mandatory = $true)]
  [string]$VoiceName,

  [Parameter(Mandatory = $true)]
  [string]$VoiceId
)

$ErrorActionPreference = "Stop"
$invariant = [System.Globalization.CultureInfo]::InvariantCulture
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot "assets\audio\voiceover-scenes.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$sceneDirectory = Join-Path $projectRoot "assets\audio\voice-scenes\$VoiceKey"
$outputPath = Join-Path $projectRoot "assets\audio\flujo-voiceover-$VoiceKey.mp3"
$proxyUrl = "http://localhost:4200/mcp-proxy/mcp-server-elevenlabs"
$headers = @{
  Accept = "application/json, text/event-stream"
  "Content-Type" = "application/json"
}

New-Item -ItemType Directory -Path $sceneDirectory -Force | Out-Null

function Format-Number([double]$Value) {
  return $Value.ToString("0.########", $invariant)
}

function Get-AtempoFilter([double]$Tempo) {
  $parts = [System.Collections.Generic.List[string]]::new()
  while ($Tempo -gt 2.0) {
    $parts.Add("atempo=2")
    $Tempo /= 2.0
  }
  while ($Tempo -lt 0.5) {
    $parts.Add("atempo=0.5")
    $Tempo /= 0.5
  }
  $parts.Add("atempo=$(Format-Number $Tempo)")
  return $parts -join ","
}

function Invoke-ElevenLabsSpeech([string]$Text, [int]$RequestId) {
  $body = @{
    jsonrpc = "2.0"
    id = $RequestId
    method = "tools/call"
    params = @{
      name = "generate_speech"
      arguments = @{
        text = $Text
        voice_id = $VoiceId
        model_id = "eleven_v3"
        stability = 0.42
        similarity_boost = 0.8
        output_format = "mp3_44100_128"
      }
    }
  } | ConvertTo-Json -Depth 12

  $response = Invoke-RestMethod -Uri $proxyUrl -Method Post -Headers $headers -Body $body -TimeoutSec 180
  $payload = $response.result.content[0].text | ConvertFrom-Json
  if (-not $payload.ok -or -not $payload.file_path) {
    throw "ElevenLabs generation failed for request $RequestId."
  }
  return $payload.file_path
}

$sceneNumber = 0
foreach ($scene in $manifest.scenes) {
  $sceneNumber += 1
  $rawPath = Join-Path $sceneDirectory ("scene-{0:D2}-raw.mp3" -f $sceneNumber)
  if (-not (Test-Path -LiteralPath $rawPath)) {
    Write-Host "Generating $VoiceName scene $sceneNumber of $($manifest.scenes.Count)..."
    $generatedPath = Invoke-ElevenLabsSpeech -Text $scene.text -RequestId (1000 + $sceneNumber)
    Copy-Item -LiteralPath $generatedPath -Destination $rawPath -Force
  } else {
    Write-Host "Reusing $VoiceName scene $sceneNumber."
  }
}

$buildDirectory = Join-Path ([IO.Path]::GetTempPath()) ("flujo-voice-build-{0}-{1}" -f $VoiceKey, [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null

try {
  $fittedScenes = [System.Collections.Generic.List[string]]::new()
  $sceneNumber = 0
  foreach ($scene in $manifest.scenes) {
    $sceneNumber += 1
    $rawPath = Join-Path $sceneDirectory ("scene-{0:D2}-raw.mp3" -f $sceneNumber)
    $fittedPath = Join-Path $buildDirectory ("scene-{0:D2}-fitted.wav" -f $sceneNumber)
    $sourceDuration = [double](& ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $rawPath)
    $targetDuration = [double]$scene.duration
    $tempo = $sourceDuration / $targetDuration
    $atempo = Get-AtempoFilter $tempo
    $targetText = Format-Number $targetDuration
    $filter = "$atempo,apad=pad_dur=$targetText"

    & ffmpeg -y -hide_banner -loglevel error -i $rawPath -af $filter -t $targetText -ar 44100 -ac 1 -c:a pcm_s16le $fittedPath
    if ($LASTEXITCODE -ne 0) {
      throw "ffmpeg failed while fitting scene $sceneNumber."
    }
    $fittedScenes.Add($fittedPath)
  }

  $gapPath = Join-Path $buildDirectory "gap.wav"
  $gapText = Format-Number ([double]$manifest.sceneGap)
  & ffmpeg -y -hide_banner -loglevel error -f lavfi -i "anullsrc=r=44100:cl=mono" -t $gapText -c:a pcm_s16le $gapPath
  if ($LASTEXITCODE -ne 0) {
    throw "ffmpeg failed while creating the scene gap."
  }

  $concatPath = Join-Path $buildDirectory "concat.txt"
  $concatLines = [System.Collections.Generic.List[string]]::new()
  for ($index = 0; $index -lt $fittedScenes.Count; $index += 1) {
    $escapedScene = $fittedScenes[$index].Replace("'", "'\''")
    $concatLines.Add("file '$escapedScene'")
    if ($index -lt $fittedScenes.Count - 1) {
      $escapedGap = $gapPath.Replace("'", "'\''")
      $concatLines.Add("file '$escapedGap'")
    }
  }
  Set-Content -LiteralPath $concatPath -Value $concatLines -Encoding utf8

  $combinedPath = Join-Path $buildDirectory "combined.wav"
  & ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i $concatPath -c:a pcm_s16le $combinedPath
  if ($LASTEXITCODE -ne 0) {
    throw "ffmpeg failed while concatenating scenes."
  }

  & ffmpeg -y -hide_banner -loglevel error -i $combinedPath -af "loudnorm=I=-16:TP=-1.5:LRA=7" -ar 44100 -ac 1 -c:a libmp3lame -b:a 128k $outputPath
  if ($LASTEXITCODE -ne 0) {
    throw "ffmpeg failed while normalizing the final voiceover."
  }

  $finalDuration = [double](& ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $outputPath)
  $metadata = [ordered]@{
    voiceKey = $VoiceKey
    voiceName = $VoiceName
    voiceId = $VoiceId
    modelId = "eleven_v3"
    stability = 0.42
    similarityBoost = 0.8
    targetDuration = [double]$manifest.totalDuration
    finalDuration = $finalDuration
    outputFile = [IO.Path]::GetFileName($outputPath)
  }
  $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sceneDirectory "metadata.json") -Encoding utf8

  Write-Host ("Created {0} ({1:N3}s)." -f $outputPath, $finalDuration)
}
finally {
  $resolvedBuild = [IO.Path]::GetFullPath($buildDirectory)
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedBuild.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedBuild)) {
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
  }
}
