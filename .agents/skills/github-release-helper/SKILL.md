---
name: github-release-helper
description: Use this skill when releasing a new version of SINC PRO, building the executable, pushing to GitHub, or handling permission errors and authorization tokens.
---

# Навык: Сборка и публикация релизов SINC PRO

Этот навык используется ИИ-агентом для правильной компиляции, оформления и отправки релизов SINC PRO на GitHub.

## Важное правило публикации
* **ЗАПРЕЩЕНО** выполнять команды отправки изменений в удаленный репозиторий (`git push`) или создания релизов на GitHub (`gh release create`) без явного, прямого указания пользователя. Всегда завершай изменения локально и жди команды пользователя для публикации.

## 1. Сборка проекта и очистка заблокированных файлов
Перед запуском компиляции через `PyInstaller` (или при возникновении ошибки `PermissionError: [WinError 5]` при записи `SINC_PRO.exe`):
1. Проверь, запущен ли процесс `SINC_PRO.exe` в системе.
2. Принудительно заверши его командой:
   ```powershell
   taskkill /f /im SINC_PRO.exe
   ```
3. Только после этого запускай команду сборки:
   ```powershell
   python -m PyInstaller SINC_PRO.spec --clean --noconfirm
   ```

## 2. Глобальная авторизация в GitHub
Если при выполнении любых авторизованных команд Git или GitHub CLI (`gh`) возникает ошибка доступа `HTTP 401 Unauthorized`:
1. Проверь наличие переменной окружения `GITHUB_PERSONAL_ACCESS_TOKEN` в Windows.
2. Если она задана, используй её значение для переопределения стандартных переменных в текущей сессии PowerShell перед вызовом команд `gh` или `git`:
   ```powershell
   $env:GITHUB_TOKEN = $env:GITHUB_PERSONAL_ACCESS_TOKEN
   $env:GH_TOKEN = $env:GITHUB_PERSONAL_ACCESS_TOKEN
   ```

## 3. Языковой стандарт и оформление
* **Язык общения:** Общайся с пользователем исключительно на русском языке.
* **Документация:** Все создаваемые или обновляемые markdown-документы (включая `CHANGELOG.md`, `README.md`, `walkthrough.md`) должны быть написаны строго на русском языке.
* **Журнал изменений:** При подготовке нового релиза обязательно обновляй `CHANGELOG.md` по стандарту *Keep a Changelog*, добавляя описание изменений в соответствующую секцию перед отправкой коммита.
