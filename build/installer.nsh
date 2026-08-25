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
; 페이지·함수 정의 전체를 이 매크로 안에 둔다 — electron-builder 는 이 파일을
; 스크립트 최상단(MUI2/LogicLib 로드 전)에 !include 하므로, 밖에 두면
; MUI_HEADER_TEXT/${If}/NSD_* 가 미정의다. 이 매크로는 페이지 나열 시점
; (MUI2 로드 후)에 삽입되므로 안전하다. NSIS 는 Function 정의를 페이지 나열
; 위치에 두는 것을 허용한다.
!macro customPageAfterChangeDir
  ; Var 는 여기(설치자 패스에서만 삽입되는 매크로) 안에 선언한다 —
  ; 전역에 두면 uninstaller 컴파일 패스(훅 미삽입)에서 미사용 경고(6001)가
  ; warning-as-error 로 빌드를 죽인다(실기). customInstall 은 페이지 이후에
  ; 삽입되므로 이 선언을 그대로 쓴다.
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

  !include nsDialogs.nsh
  !include LogicLib.nsh

  Page custom XgenDataPageCreate XgenDataPageLeave

  ; 앱이 매 부팅 남기는 실효 데이터 루트 마커(UTF-16LE, 1줄) — 업데이트 설치/언인스톨이 읽는다.
  Function XgenReadDataRootMarker
    Push $0
    Push $1
    StrCpy $1 ""
    IfFileExists "$APPDATA\XGEN-Connector\data-root.txt" 0 xrm_done
    FileOpen $0 "$APPDATA\XGEN-Connector\data-root.txt" r
    ${If} $0 != ""
      FileReadUTF16LE $0 $1
      FileClose $0
    ${EndIf}
    ; 개행/BOM 제거
    xrm_trim:
      StrCpy $0 $1 1 -1
      ${If} $0 == "$\r"
      ${OrIf} $0 == "$\n"
        StrCpy $1 $1 -1
        Goto xrm_trim
      ${EndIf}
      StrCpy $0 $1 1
      ${If} $0 == "${U+FEFF}"
        StrCpy $1 $1 "" 1
      ${EndIf}
  xrm_done:
    Pop $0
    Exch $1
  FunctionEnd

  Function XgenDataPageCreate
    ; 업데이트 설치(앱이 띄운 인스톨러)는 이 페이지를 건너뛴다 — 사용자가 정한 데이터 폴더/
    ; 구성요소 선택을 기본값으로 덮어쓰지 않는다. 런타임 복사 대상은 마커에서 읽는다.
    ${If} ${isUpdated}
      Call XgenReadDataRootMarker
      Pop $XgenDataRoot
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "데이터 폴더" "에이전트 작업 폴더와 로컬 실행 구성요소가 설치될 위치입니다."
    nsDialogs::Create 1018
    Pop $XgenDlg
    ${If} $XgenDlg == error
      Abort
    ${EndIf}

    ${If} $XgenDataRoot == ""
      Call XgenReadDataRootMarker
      Pop $XgenDataRoot
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

  ; ── 런타임 트리 복사(항목별 로그) ────────────────────────────────────────
  ; CopyFiles 한 방(1GB+, 수십 초 무소음) 대신 **항목 단위**로 복사하며 매 항목을 설치 화면
  ; 상세 로그와 install.log 에 찍는다 — 사용자가 "설치가 진행 중인지, 어디서 막혔는지"를
  ; 화면에서 바로 본다. Lib 와 site-packages 는 한 단계 더 들어가 패키지 단위로 찍는다.
  ;   입력: 스택 top = dst, 그 아래 = src   (Push src ; Push dst ; Call XgenCopyEntries)
  Function XgenCopyEntries
    Exch $1            ; dst
    Exch
    Exch $0            ; src
    Push $2
    Push $3
    Push $4
    CreateDirectory "$1"
    FindFirst $2 $3 "$0\*.*"
    xce_loop:
      StrCmp $3 "" xce_done
      StrCmp $3 "." xce_next
      StrCmp $3 ".." xce_next
      IfFileExists "$0\$3\*.*" xce_dir xce_file
    xce_dir:
      StrCpy $4 0
      StrCmp $3 "Lib" xce_deep
      StrCmp $3 "site-packages" xce_deep
      DetailPrint "복사: $3\"
      ClearErrors
      CopyFiles /SILENT "$0\$3" "$1"
      ${If} ${Errors}
        DetailPrint "  ! 복사 오류: $3"
        !insertmacro XgenLog "copy ERROR dir $0\$3"
      ${EndIf}
      Goto xce_next
    xce_deep:
      DetailPrint "복사: $3\ (항목별)"
      Push $0
      Push $1
      Push $2
      Push $3
      Push "$0\$3"
      Push "$1\$3"
      Call XgenCopyEntries
      Pop $3
      Pop $2
      Pop $1
      Pop $0
      Goto xce_next
    xce_file:
      DetailPrint "복사: $3"
      ClearErrors
      CopyFiles /SILENT "$0\$3" "$1\$3"
      ${If} ${Errors}
        DetailPrint "  ! 복사 오류: $3"
        !insertmacro XgenLog "copy ERROR file $0\$3"
      ${EndIf}
    xce_next:
      FindNext $2 $3
      Goto xce_loop
    xce_done:
    FindClose $2
    Pop $4
    Pop $3
    Pop $2
    Pop $0
    Pop $1
  FunctionEnd
  
  ; ── 설치 진행(INSTFILES) 페이지: 상세 로그를 **처음부터** 보인다 ──────────
  ; 템플릿은 ShowInstDetails nevershow + 섹션 시작 SetDetailsPrint none 이라 로그가 숨겨지고,
  ; customInstall(앱 파일 추출 **후**)에서야 켜진다. 런타임을 재사용(같은 버전 → 복사 생략)하는
  ; 설치/업데이트에서는 그 구간이 1~2초라 페이지가 바로 넘어가 사용자는 로그를 전혀 못 본다
  ; (v1.71.0 실기: "로그 기능이 사라졌다"). INSTFILES SHOW 콜백은 섹션보다 먼저 돌므로 여기서
  ; 상세 뷰를 켠다(SetDetailsView). 이 define 은 바로 뒤의 MUI_PAGE_INSTFILES(템플릿
  ; assistedInstaller.nsh)가 소비한다.
  ;
  ; ⚠ SetAutoClose 는 절대 여기서 false 로 두지 않는다. MUI_PAGE_FINISH(뒤에 이어지는
  ; 표준 마침 페이지 — customFinishPage 미정의라 템플릿 기본값)는 .onGUIInit(MUI_FINISHPAGE_GUIINIT)
  ; 에서 SetAutoClose true 를 스스로 건다 — 그래야 INSTFILES 가 끝나자마자 자동으로 마침 페이지로
  ; 넘어간다. 여기서 false 로 덮으면 설치는 끝나지만 페이지가 넘어가지 않고 "[닫기]" 버튼만
  ; 조용히 활성화된다 — 사용자에게는 그냥 멈춘 것으로 보인다(실기: v1.71.1, 첫 설치·Windows에서
  ; "log 파일 관련 화면에서 멈추고 안 넘어간다" — 마지막으로 보이는 줄이 install.log 안내라 로그
  ; 자체가 원인처럼 보이지만, 실제로는 이 자동 전환 억제가 원인이다). 로그는 SetDetailsView 만으로
  ; 이미 설치 시작부터 끝까지 보인다 — 자동 전환을 막을 이유가 없다.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW XgenInstFilesShow
  Function XgenInstFilesShow
    SetDetailsView show
    SetDetailsPrint both
    DetailPrint "XGEN Connector ${VERSION} 설치를 시작합니다."
    DetailPrint "1/3 앱 파일 압축 해제 — 진행 막대를 확인하세요 (이 단계는 줄 단위 로그가 없습니다)."
    DetailPrint "설치 로그 파일: $APPDATA\XGEN-Connector\install.log"
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
; ── 설치 로그 — %APPDATA%\XGEN-Connector\install.log (앱이 같은 이름의 로그를 설치 폴더에도 쓴다) ──
; 런타임 복사/검증의 모든 단계와 결과를 남긴다 — "왜 실패했는지" 를 설치 직후 파일로 볼 수 있게.
; ⚠ 메시지는 **ASCII 만**(화살표 -> / 대시 - / 영문) — Unicode NSIS 의 FileWrite 는 ANSI(CP949)로 쓰고
;   앱은 같은 파일에 UTF-8 로 이어 쓴다. 비ASCII 를 넣으면 앱 화면에서 "copy done �� C:\…" 로 깨진다
;   (v1.68~1.70). 경로($XgenDataRoot 등)의 한글은 앱이 줄 단위 EUC-KR 폴백으로 디코드한다.
!macro XgenLog text
  Push $9
  CreateDirectory "$APPDATA\XGEN-Connector"
  FileOpen $9 "$APPDATA\XGEN-Connector\install.log" a
  ${If} $9 != ""
    FileSeek $9 0 END
    FileWrite $9 "${text}$\r$\n"
    FileClose $9
  ${EndIf}
  Pop $9
!macroend

!macro customInstall
  ; 설치 화면에 상세 로그를 **보이게** 한다(템플릿은 nevershow+DetailsPrint none — 여기서부터 켠다).
  SetDetailsPrint both
  SetDetailsView show
  DetailPrint "2/3 앱 파일 설치 완료 — 로컬 실행 환경을 구성합니다."
  DetailPrint "설치 로그: $APPDATA\XGEN-Connector\install.log"
  ; 우리 파일(로그/옵션/마커)은 Electron 의 userData(%APPDATA%) 와 같은 곳 — per-machine 설치여도
  ; 현재 사용자 컨텍스트로 쓴다(electron-builder 자신도 $LOCALAPPDATA 쓸 때 같은 방식).
  ${If} $installMode == "all"
    SetShellVarContext current
  ${EndIf}
  !insertmacro XgenLog "==== XGEN Connector ${VERSION} install start ===="
  !insertmacro XgenLog "INSTDIR=$INSTDIR installMode=$installMode"
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
  ${If} $XgenDataRoot == ""
    Call XgenReadDataRootMarker
    Pop $XgenDataRoot
  ${EndIf}
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
  ${If} ${isUpdated}
    ; 업데이트: 사용자의 기존 선택(config)을 덮지 않는다 — 옵션 파일을 쓰지 않는다.
    !insertmacro XgenLog "update install - install-options.json not written (keep existing config)"
  ${Else}
    Push $XgenDataRoot
    Call XgenJsonEscape
    Pop $4
    CreateDirectory "$APPDATA\XGEN-Connector"
    FileOpen $0 "$APPDATA\XGEN-Connector\install-options.json" w
    ${If} $0 != ""
      ; UTF-16LE(BOM) — Unicode NSIS 의 FileWrite 는 ANSI 로 써 한글 경로가 깨진다(앱은 BOM 으로 판별).
      FileWriteUTF16LE /BOM $0 '{"dataRoot":"$4","autoRuntime":$1,"autoCodex":$2,"autoClaude":$3}'
      FileClose $0
    ${EndIf}
    ; 마커도 처음 한 번 써 둔다(앱이 부팅마다 갱신) — 언인스톨러가 런타임 위치를 안다.
    FileOpen $0 "$APPDATA\XGEN-Connector\data-root.txt" w
    ${If} $0 != ""
      FileWriteUTF16LE $0 "$XgenDataRoot"
      FileClose $0
    ${EndIf}
  ${EndIf}

  ; ── 로컬 실행 런타임을 **설치 시점에** 설치 폴더로 복사 ────────────────
  ; 번들(resources\python)은 이 설치본 안에 이미 있다 — 앱이 뜬 뒤 내려받는
  ; 것이 아니라 인스톨러가 지금 깐다(오프라인, 결정적). 앱은 뜨는 순간
  ; <설치폴더>\local-runtime\python 을 발견한다("설치 중" 상태가 존재하지 않는다).
  !insertmacro XgenLog "dataRoot=$XgenDataRoot runtime=$XgenRuntimeState codex=$XgenCodexState claude=$XgenClaudeState"
  ${If} $XgenRuntimeState == 1
    DetailPrint "로컬 실행 런타임을 설치하는 중... (수십 초 소요)"
    ; 번들 레이아웃 확인 — resources\python\python.exe 가 있어야 한다(v1.62~1.66 은 한 단계
    ; 더 깊게 들어가 있어 복사본이 앱·런타임 경로와 맞지 않았다).
    ${If} ${FileExists} "$INSTDIR\resources\python\python.exe"
      !insertmacro XgenLog "bundle OK: $INSTDIR\resources\python\python.exe"
    ${Else}
      !insertmacro XgenLog "bundle MISSING: $INSTDIR\resources\python\python.exe (app repairs/downloads on first run)"
    ${EndIf}
    ; ── 재사용 판정: 설치 폴더에 **같은 버전**의 런타임이 이미 있고 실행되면 다시 복사하지 않는다
    ;    (업데이트 때 1GB 삭제/복사로 시간을 낭비하지 않는다). 버전 스탬프 RUNTIME_VERSION(번들 스크립트) 비교.
    StrCpy $5 ""
    StrCpy $6 ""
    ${If} ${FileExists} "$INSTDIR\resources\python\RUNTIME_VERSION"
      FileOpen $0 "$INSTDIR\resources\python\RUNTIME_VERSION" r
      ${If} $0 != ""
        FileRead $0 $5
        FileClose $0
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$XgenDataRoot\local-runtime\python\RUNTIME_VERSION"
      FileOpen $0 "$XgenDataRoot\local-runtime\python\RUNTIME_VERSION" r
      ${If} $0 != ""
        FileRead $0 $6
        FileClose $0
      ${EndIf}
    ${EndIf}
    StrCpy $7 0
    ${If} $5 != ""
    ${AndIf} $5 == $6
    ${AndIf} ${FileExists} "$XgenDataRoot\local-runtime\python\python.exe"
      nsExec::ExecToStack '"$XgenDataRoot\local-runtime\python\python.exe" -I -c "import xgen_agent_runtime.host.sidecar"'
      Pop $0
      Pop $1
      ${If} $0 == 0
        StrCpy $7 1
      ${EndIf}
    ${EndIf}
    ${If} $7 == 1
      DetailPrint "로컬 실행 런타임 재사용 — 이미 같은 버전이 설치되어 있습니다 ($5)"
      !insertmacro XgenLog "runtime reuse (same version $5, smoke OK) - copy skipped"
    ${Else}
      DetailPrint "런타임 복사: $INSTDIR\resources\python → $XgenDataRoot\local-runtime\python"
      !insertmacro XgenLog "copy start -> $XgenDataRoot\local-runtime\python (bundle=$5 installed=$6)"
      CreateDirectory "$XgenDataRoot\local-runtime"
      RMDir /r "$XgenDataRoot\local-runtime\python"
      Push "$INSTDIR\resources\python"
      Push "$XgenDataRoot\local-runtime\python"
      Call XgenCopyEntries
      DetailPrint "런타임 복사 완료"
      !insertmacro XgenLog "copy done -> $XgenDataRoot\local-runtime\python"
    ${EndIf}
    ${If} ${FileExists} "$XgenDataRoot\local-runtime\python\python.exe"
      !insertmacro XgenLog "copied python.exe present"
    ${Else}
      !insertmacro XgenLog "copied python.exe MISSING after copy"
    ${EndIf}
    ; 복사본 검증(import 스모크) — 실패해도 설치는 계속한다(앱이 부팅 때 내장 번들에서 복구).
    DetailPrint "로컬 실행 런타임을 검증하는 중..."
    nsExec::ExecToStack '"$XgenDataRoot\local-runtime\python\python.exe" -c "import xgen_agent_runtime.host.sidecar; print(1)"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      DetailPrint "런타임 검증 OK (import xgen_agent_runtime.host.sidecar)"
      !insertmacro XgenLog "smoke OK"
    ${Else}
      DetailPrint "런타임 검증 실패(코드 $0) — 앱 첫 실행 시 자동 복구됩니다."
      !insertmacro XgenLog "smoke FAILED rc=$0: $1"
    ${EndIf}
  ${Else}
    !insertmacro XgenLog "runtime install skipped (unchecked)"
  ${EndIf}
  DetailPrint "Codex / Claude Code CLI 는 앱 첫 실행 시 자동 설치·서버 버전 수렴됩니다(설정 → 설치 에서 확인)."
  DetailPrint "설치 완료."
  !insertmacro XgenLog "==== install end ===="
  DetailPrint "3/3 설치 완료 — 마침 화면으로 넘어갑니다."
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend

!macro customUnInstall
  ; 상한 조정은 되돌리지 않는다 — 다른 WebDAV 클라이언트도 쓰는 시스템
  ; 설정이고, 낮추는 것이 사용자에게 이득이 되는 경우가 없다.
  ;
  ; 로컬 실행 런타임(<데이터 폴더>\local-runtime: Python 1GB+, CLI, 격리 홈)은 사용자 데이터가
  ; 아니다 — 진짜 제거(업데이트가 아닌)일 때 물어보고 지운다. workspace/·cloud/ 는 건드리지 않는다.
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    StrCpy $1 ""
    IfFileExists "$APPDATA\XGEN-Connector\data-root.txt" 0 +6
      FileOpen $0 "$APPDATA\XGEN-Connector\data-root.txt" r
      ${If} $0 != ""
        FileReadUTF16LE $0 $1
        FileClose $0
      ${EndIf}
    ; 개행 제거
    un_trim:
      StrCpy $0 $1 1 -1
      ${If} $0 == "$\r"
      ${OrIf} $0 == "$\n"
        StrCpy $1 $1 -1
        Goto un_trim
      ${EndIf}
    StrCmp $1 "" 0 +2
      StrCpy $1 "$PROFILE\xgen-connector"
    ${If} ${FileExists} "$1\local-runtime\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION "로컬 실행 런타임 폴더도 삭제할까요?$\r$\n$1\local-runtime$\r$\n(작업 폴더 workspace\ 와 cloud\ 는 남습니다)" IDNO +2
        RMDir /r "$1\local-runtime"
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
