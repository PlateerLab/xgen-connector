; XGEN Connector — NSIS 설치 커스터마이즈
;
; ── 데이터 폴더 선택 페이지 ─────────────────────────────────────────────
; 커넥터의 모든 작업 자산(workspace/ · cloud/ · local-runtime/ + codex/claude CLI)
; 은 **통합 루트**(기본 %USERPROFILE%\xgen-connector) 아래에 모인다. 이 페이지가
; 루트 경로와 구성요소 체크(기본 전부 체크)를 받아
;   %APPDATA%\XGEN-Connector\install-options.json
; 으로 남기면, 앱 첫 부팅(data-root.consumeInstallOptions)이 한 번 삼켜 config 에
; 반영하고 체크된 것들을 자동 설치한다(인스톨러는 다운로드하지 않는다 — 오프라인
; 설치를 깨지 않기 위해; 실제 설치는 앱의 부팅 프로비저닝이 수행).
Var XgenDataRoot
Var XgenDlg
Var XgenDirBox
Var XgenDirBtn
Var XgenChkRuntime
Var XgenChkCodex
Var XgenChkClaude
Var XgenRuntimeState
Var XgenCodexState
Var XgenClaudeState

; 페이지·함수 정의 전체를 이 매크로 안에 둔다 — electron-builder 는 이 파일을
; 스크립트 최상단(MUI2/LogicLib 로드 전)에 !include 하므로, 밖에 두면
; MUI_HEADER_TEXT/${If}/NSD_* 가 미정의다. 이 매크로는 페이지 나열 시점
; (MUI2 로드 후)에 삽입되므로 안전하다. NSIS 는 Function 정의를 페이지 나열
; 위치에 두는 것을 허용한다.
!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Page custom XgenDataPageCreate XgenDataPageLeave

  Function XgenDataPageCreate
    !insertmacro MUI_HEADER_TEXT "데이터 폴더" "에이전트 작업 폴더와 로컬 실행 구성요소가 설치될 위치입니다."
    nsDialogs::Create 1018
    Pop $XgenDlg
    ${If} $XgenDlg == error
      Abort
    ${EndIf}

    StrCmp $XgenDataRoot "" 0 +2
      StrCpy $XgenDataRoot "$PROFILE\xgen-connector"

    ${NSD_CreateLabel} 0 0 100% 24u "이 폴더 아래에 workspace\(작업·동기화), cloud\(스토리지), local-runtime\(에이전트 로컬 실행 런타임과 CLI)이 만들어집니다."
    Pop $0

    ${NSD_CreateDirRequest} 0 28u 82% 13u "$XgenDataRoot"
    Pop $XgenDirBox
    ${NSD_CreateBrowseButton} 84% 28u 16% 13u "찾아보기…"
    Pop $XgenDirBtn
    ${NSD_OnClick} $XgenDirBtn XgenBrowseDir

    ${NSD_CreateCheckbox} 0 52u 100% 12u "에이전트 로컬 실행 런타임 (권장 — 에이전트가 이 PC 에서 실행됩니다)"
    Pop $XgenChkRuntime
    ${NSD_Check} $XgenChkRuntime
    ${NSD_CreateCheckbox} 0 66u 100% 12u "Codex CLI (OpenAI Codex provider 로컬 실행)"
    Pop $XgenChkCodex
    ${NSD_Check} $XgenChkCodex
    ${NSD_CreateCheckbox} 0 80u 100% 12u "Claude Code CLI (Claude Code provider 로컬 실행)"
    Pop $XgenChkClaude
    ${NSD_Check} $XgenChkClaude

    ${NSD_CreateLabel} 0 98u 100% 20u "체크된 항목은 첫 실행 시 자동으로 설치됩니다. 나중에 [설정 → 일반]에서 변경할 수 있습니다."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function XgenBrowseDir
    ${NSD_GetText} $XgenDirBox $0
    nsDialogs::SelectFolderDialog "데이터 폴더 선택" "$0"
    Pop $0
    ${If} $0 != error
      ${NSD_SetText} $XgenDirBox "$0"
    ${EndIf}
  FunctionEnd

  Function XgenDataPageLeave
    ${NSD_GetText} $XgenDirBox $XgenDataRoot
    ${NSD_GetState} $XgenChkRuntime $XgenRuntimeState
    ${NSD_GetState} $XgenChkCodex $XgenCodexState
    ${NSD_GetState} $XgenChkClaude $XgenClaudeState
  FunctionEnd

  ; JSON 문자열 값으로 안전하게 — 백슬래시 이스케이프(\ → \\).
  Function XgenJsonEscape
    Exch $0
    Push $1
    Push $2
    Push $3
    StrCpy $1 ""
    StrCpy $2 0
    loop:
      StrCpy $3 $0 1 $2
      StrCmp $3 "" done
      StrCmp $3 "\" 0 +3
        StrCpy $1 "$1\\"
        Goto next
      StrCpy $1 "$1$3"
    next:
      IntOp $2 $2 + 1
      Goto loop
    done:
    StrCpy $0 $1
    Pop $3
    Pop $2
    Pop $1
    Exch $0
  FunctionEnd
!macroend
;
; Windows 내장 WebDAV 클라이언트(WebClient)는 기본 **50MB 파일 상한**이 있다
; (FileSizeLimitInBytes). 가상 드라이브로 붙은 워크스페이스에서 그보다 큰
; 파일을 열거나 저장하면 탐색기가 조용히 거부한다 — 사용자에게는 "파일이
; 안 열린다"로만 보인다.
;
; 설치 프로그램은 관리자 권한으로 도므로 여기서 상한을 올린다(4GB).
; 서비스는 다음 시작 때 새 값을 읽는다.
!macro customInstall
  DetailPrint "WebDAV 파일 크기 상한을 조정하는 중..."
  ; 0xFFFFFFFF = 4GiB-1 (WebClient 가 받는 최대값)
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\WebClient\Parameters" "FileSizeLimitInBytes" 0xFFFFFFFF
  ; PROPFIND 응답 크기 상한 (기본 1,000,000 바이트).
  ;
  ; 폴더 하나의 목록 응답이 이 값을 넘으면 **탐색기가 폴더를 빈 것으로
  ; 표시한다** — 사용자에게는 "파일이 다 사라졌다"로 보인다. 항목 하나가
  ; 대략 600 바이트이므로 기본값은 폴더당 ~1600 개에서 걸린다. 워크스페이스
  ; 하나에 그만큼 쌓이는 건 드문 일이 아니다.
  DetailPrint "WebDAV 목록 응답 상한을 조정하는 중..."
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\WebClient\Parameters" "FileAttributesLimitInBytes" 0x03D09000
  ; 서버 응답 대기 시간 (기본 30초). 로컬 서버지만 뒤에서 XGEN 을 왕복하므로
  ; 느린 회선에서 큰 파일의 첫 조각이 30초를 넘길 수 있다.
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Services\WebClient\Parameters" "InternetServerTimeoutInSec" 0x0000012C
  ; WebClient 는 기본 수동 시작 — 자동으로 두면 마운트가 첫 시도에 붙는다.
  nsExec::ExecToLog 'sc config WebClient start= auto'
  Pop $0

  ; ── 데이터 폴더/구성요소 선택을 앱에 전달 ──────────────────────────────
  ; 첫 부팅(consumeInstallOptions)이 한 번 읽고 지운다. 페이지를 안 거친 경우
  ; (조용한 설치 /S)엔 기본값으로 남긴다.
  DetailPrint "데이터 폴더 설정을 기록하는 중..."
  StrCmp $XgenDataRoot "" 0 +2
    StrCpy $XgenDataRoot "$PROFILE\xgen-connector"
  StrCmp $XgenRuntimeState "" 0 +2
    StrCpy $XgenRuntimeState 1
  StrCmp $XgenCodexState "" 0 +2
    StrCpy $XgenCodexState 1
  StrCmp $XgenClaudeState "" 0 +2
    StrCpy $XgenClaudeState 1
  ${If} $XgenRuntimeState == 1
    StrCpy $1 "true"
  ${Else}
    StrCpy $1 "false"
  ${EndIf}
  ${If} $XgenCodexState == 1
    StrCpy $2 "true"
  ${Else}
    StrCpy $2 "false"
  ${EndIf}
  ${If} $XgenClaudeState == 1
    StrCpy $3 "true"
  ${Else}
    StrCpy $3 "false"
  ${EndIf}
  Push $XgenDataRoot
  Call XgenJsonEscape
  Pop $4
  CreateDirectory "$APPDATA\XGEN-Connector"
  FileOpen $0 "$APPDATA\XGEN-Connector\install-options.json" w
  ${If} $0 != ""
    FileWrite $0 '{"dataRoot":"$4","autoRuntime":$1,"autoCodex":$2,"autoClaude":$3}'
    FileClose $0
  ${EndIf}
!macroend

!macro customUnInstall
  ; 상한 조정은 되돌리지 않는다 — 다른 WebDAV 클라이언트도 쓰는 시스템
  ; 설정이고, 낮추는 것이 사용자에게 이득이 되는 경우가 없다.
!macroend
