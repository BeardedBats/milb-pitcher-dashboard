' Launches the LOCAL MiLB Pitcher Dashboard (backend + CRA frontend) from this
' folder, then opens the browser once the dev server answers.
Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Start backend server (completely hidden)
WshShell.Run "cmd /c ""title MiLB Pitcher Dashboard Backend && cd /d """ & projectDir & "\backend"" && python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload""", 0, False

' Start frontend dev server (completely hidden)
WshShell.Run "cmd /c ""title MiLB Pitcher Dashboard Frontend && cd /d """ & projectDir & "\frontend"" && npm start""", 0, False

' Poll localhost:3847 until frontend is ready, then open browser
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1000, 1000, 1000, 1000
ready = False
For i = 1 To 60
    On Error Resume Next
    http.Open "GET", "http://localhost:3847", False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then
        ready = True
        On Error GoTo 0
        Exit For
    End If
    On Error GoTo 0
    WScript.Sleep 1000
Next

If ready Then
    WshShell.Run "http://localhost:3847", 1, False
End If
