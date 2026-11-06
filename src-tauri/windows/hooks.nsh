!macro NSIS_HOOK_PREINSTALL
  ; Удаляем устаревшие записи реестра от старых сборок tauri-app и дублирующиеся записи в соседнем улье реестра,
  ; чтобы в списке «Установленные приложения» Windows всегда была ровно одна актуальная запись SincPro.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\tauri-app"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\tauri-app"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SincPro"
!macroend
