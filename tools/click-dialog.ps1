# Clica num botão de uma caixa de diálogo do Windows por automação (UI Automation), sem precisar de foco.
# Uso: powershell -File tools/click-dialog.ps1 -Janela GiroPlay -Botao Sair [-EsperaSeg 15]
#      (-Janela '*' procura o botão em qualquer janela)
# Saída: "clicou" ou "nao achou". Usado pelos testes para responder "Sair" na confirmação do GiroPlay.
param([string]$Janela = 'GiroPlay', [string]$Botao = 'Sair', [int]$EsperaSeg = 15)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$fim = (Get-Date).AddSeconds($EsperaSeg)
$root = [System.Windows.Automation.AutomationElement]::RootElement
$tipoBotao = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$nomeBotao = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Botao)
$cond = New-Object System.Windows.Automation.AndCondition($tipoBotao, $nomeBotao)
while ((Get-Date) -lt $fim) {
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($Janela -ne '*' -and $w.Current.Name -ne $Janela) { continue }
    $b = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($b) {
      $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      'clicou'
      exit 0
    }
  }
  Start-Sleep -Milliseconds 300
}
'nao achou'
exit 1
