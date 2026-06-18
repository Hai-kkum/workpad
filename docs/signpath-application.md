# SignPath Foundation 신청 정보 (Workpad)

> 2026-06-18 작성. 서명 게시자 = **SignPath Foundation(무료)** 확정 → [DECISION-MEMO D1](DECISION-MEMO-배포서명-2026-06-16.md).
> 신청은 웹 폼(사용자 직접 제출). 승인되면 CI 워크플로에 서명 단계를 통합한다.

## 신청처
https://signpath.org/ → "Join the community" 신청 폼

## 폼 입력값 (그대로 사용)

| 항목 | 값 |
|------|-----|
| Project name | Workpad |
| Repository | https://github.com/Hai-kkum/workpad |
| License | MIT |
| Platform | Windows (Electron) |
| Description (EN) | Fully-local, offline floating-card memo tool for contact-center agents. AES-256-GCM local encryption, PII masking, zero external communication, no telemetry. |
| Build / CI | GitHub Actions (`.github/workflows/build.yml`), electron-builder portable |
| Maintainer | Hai-kkum |

## 자격 충족 (전부 ✅)
- OSI 승인 라이선스: **MIT**
- 공개 소스 저장소: github.com/Hai-kkum/workpad
- 활발히 유지보수 중
- 공개 CI 빌드 존재: GitHub Actions
- 기능 문서화: README
- 자기 프로젝트/바이너리만 서명

## 조건 (수락 전제)
- 게시자명 = **"SignPath Foundation"** (본인 사업자명 아님)
- 프로젝트 **영구 100% 오픈소스 유지** (독점 모듈 금지)

## 승인 후 할 일 (Claude)
1. SignPath 커넥터 / 프로젝트 설정 연동
2. `.github/workflows/build.yml`에 SignPath 서명 단계 추가
3. 서명된 포터블 검증 (SmartScreen "알 수 없는 게시자" 경고 사라짐 확인)

## 참고
- 심사 기간: 수일~수주
- 태그(`v*`) 푸시 시 CI가 포터블을 GitHub Release에 첨부 (build.yml release job) → "released" 조건 강화
- 보안팀 4질문(DECISION-MEMO Q2)은 서명과 별개 트랙 (스택·사내 배포 정책)
