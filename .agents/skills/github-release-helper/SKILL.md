---
name: github-release-helper
description: Use this skill when releasing a new version of SINC PRO, building the Tauri/Rust executable, updating CHANGELOG.md, pushing to GitHub, or handling permission errors and authorization tokens.
---

# Навык: Сборка и публикация релизов SINC PRO (Rust / Tauri v2)

Этот навык используется ИИ-агентом для правильной компиляции, оформления журнала изменений (`CHANGELOG.md`) и публикации релизов SINC PRO на GitHub.

## 1. Подготовка версии и обязательное ведение `CHANGELOG.md`
Перед созданием любого нового релиза (`vX.Y.Z`):
1. Синхронно обнови номер версии в трёх файлах:
   - `src-tauri/tauri.conf.json` (`"version": "X.Y.Z"`)
   - `src-tauri/Cargo.toml` (`version = "X.Y.Z"`)
   - `src/index.html` (резервная строка отображения версии)
2. **Обязательно добавь секцию `## [X.Y.Z] - YYYY-MM-DD` в начало `CHANGELOG.md`** по стандарту *Keep a Changelog* (`### Added`, `### Changed`, `### Fixed`) на русском языке.
   - Пайплайн `.github/workflows/release.yml` автоматически извлекает текст этой секции из `CHANGELOG.md` и публикует его:
     - в описание релиза на странице **GitHub Releases** (`### ✨ Добавлено`, `### 🔄 Изменено`, `### 🛠 Исправлено`);
     - в поле `notes` манифеста автообновлений `docs/updater.json` (отображается пользователю в окне обновления внутри приложения).

## 2. Локальная проверка и сборка Rust / Tauri v2
1. **НЕ запускай `SincPro.exe` из фоновой сессии агента** (это создаёт фоновый процесс без GUI и блокирует перезапись `target/release/SincPro.exe`).
2. Если `SincPro.exe` заблокирован при сборке (`os error 5` / `Access is denied`), перед компиляцией освободи процесс или собирай через `cargo check`.
3. Команда локальной проверки и релизной сборки:
   ```powershell
   $env:RUSTUP_HOME = "C:\Users\wisey\.rustup"
   $env:CARGO_HOME = "C:\Users\wisey\.cargo"
   $env:PATH = "C:\Users\wisey\.cargo\bin;$env:PATH"
   cargo build --release
   ```

## 3. Авторизация в GitHub и публикация релиза
1. Если при вызове `gh` или `git push` возникает ошибка авторизации, проверь переменную окружения `GITHUB_PERSONAL_ACCESS_TOKEN`:
   ```powershell
   if ($env:GITHUB_PERSONAL_ACCESS_TOKEN) {
     $env:GITHUB_TOKEN = $env:GITHUB_PERSONAL_ACCESS_TOKEN
     $env:GH_TOKEN = $env:GITHUB_PERSONAL_ACCESS_TOKEN
   }
   ```
2. Отправка коммита и тега для запуска GitHub Actions (`.github/workflows/release.yml`):
   ```powershell
   git add -A
   git commit -m "vX.Y.Z: краткое описание изменений"
   git tag vX.Y.Z
   git push origin HEAD:main --tags
   ```
3. **Запрет черновиков-дубликатов (`Draft`)**:
   - В `release.yml` параметр `releaseDraft` должен оставаться `false`, чтобы черновики не зависали вверху списка релизов на GitHub поверх актуальной версии `Latest`.

## 4. Языковой стандарт
* **Язык общения и документации:** Все файлы документации (`README.md`, `CHANGELOG.md`, `docs/PROJECT_STATE.md`, `docs/ROADMAP.md`, `docs/decisions.md`) ведутся на русском языке (в `README.md` поддерживается двуязычная структура `🇷🇺 Русский | 🇺🇸 English`).
