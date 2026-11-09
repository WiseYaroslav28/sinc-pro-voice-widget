Var SavedAutostartRegValue

!define MUI_CUSTOMFUNCTION_GUIINIT SincProGuiInit

Function SincProGuiInit
  ; Сохраняем состояние автозапуска из реестра ДО того, как страница PageReinstall запустит старый uninstall.exe
  ReadRegStr $SavedAutostartRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SincPro"
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ${If} $SavedAutostartRegValue == ""
    ReadRegStr $SavedAutostartRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SincPro"
  ${EndIf}

  ; Удаляем устаревшие записи реестра от старых сборок tauri-app и дублирующиеся записи в соседнем улье реестра,
  ; чтобы в списке «Установленные приложения» Windows всегда была ровно одна актуальная запись SincPro.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\tauri-app"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\tauri-app"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SincPro"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Если до переустановки автозапуск был включён (и старый uninstall.exe стёр его при «Удалить перед установкой»),
  ; автоматически восстанавливаем запись автозапуска с актуальным путём.
  ${If} $SavedAutostartRegValue != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --minimized"
  ${EndIf}
!macroend
