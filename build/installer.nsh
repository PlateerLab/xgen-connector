; XGEN Connector — NSIS 설치 커스터마이즈
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
  ; WebClient 는 기본 수동 시작 — 자동으로 두면 마운트가 첫 시도에 붙는다.
  nsExec::ExecToLog 'sc config WebClient start= auto'
  Pop $0
!macroend

!macro customUnInstall
  ; 상한 조정은 되돌리지 않는다 — 다른 WebDAV 클라이언트도 쓰는 시스템
  ; 설정이고, 낮추는 것이 사용자에게 이득이 되는 경우가 없다.
!macroend
