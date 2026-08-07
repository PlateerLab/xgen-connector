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
!macroend

!macro customUnInstall
  ; 상한 조정은 되돌리지 않는다 — 다른 WebDAV 클라이언트도 쓰는 시스템
  ; 설정이고, 낮추는 것이 사용자에게 이득이 되는 경우가 없다.
!macroend
