package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"runtime/pprof"
	"time"
)

//TIP To run your code, right-click the code and select <b>Run</b>. Alternatively, click
// the <icon src="AllIcons.Actions.Execute"/> icon in the gutter and select the <b>Run</b> menu item from here.

func main() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: <programme> <type_code> <code_source_base64>")
		return
	}
	codeType := os.Args[1]

	encodeCode := os.Args[2]

	decodeCode, err := base64.StdEncoding.DecodeString(encodeCode)

	start := time.Now()
	if err != nil {
		fmt.Println("Erreur de décodage base64 :", err)
	}

	//code a bien regler
	var cmd *exec.Cmd
	switch codeType {
	case "py":
		cmd = exec.Command("python3", string(decodeCode))
	case "js":
		cmd = exec.Command("node", "-e", string(decodeCode))
	case "go":
		cmd = exec.Command("go", "run", string(decodeCode))
	default:
		fmt.Println("Erreur de code type :", codeType)
		return
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	cpuProfileFile, _ := os.Create("cpu.prof")
	defer cpuProfileFile.Close()
	pprof.StartCPUProfile(cpuProfileFile)
	defer pprof.StopCPUProfile()

	errr := cmd.Run()
	if errr != nil {
		fmt.Println("Erreur de programme json :", err)
	}
	elapsed := time.Since(start)

	memProfileFile, _ := os.Create("mem.prof")
	defer memProfileFile.Close()
	runtime.GC() // Forcer la collecte de garbage pour des stats précises
	pprof.WriteHeapProfile(memProfileFile)

	fmt.Printf("Temps d'exécution : %s\n", elapsed)

	// Capturer l'utilisation mémoire
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	fmt.Printf("Mémoire allouée : %v KB\n", memStats.Alloc/1024)
	fmt.Printf("Mémoire totale : %v KB\n", memStats.TotalAlloc/1024)
	fmt.Printf("Nombre de goroutines : %v\n", runtime.NumGoroutine())

	// Gestion des erreurs et affichage
	if err != nil {
		fmt.Printf("Erreur lors de l'exécution du fichier utilisateur : %v\n", err)
		fmt.Printf("Erreur : %s\n", stderr.String())
		return
	}

	// Afficher la sortie du programme utilisateur
	fmt.Printf("Sortie utilisateur :\n%s\n", stdout.String())
}

//TIP See GoLand help at <a href="https://www.jetbrains.com/help/go/">jetbrains.com/help/go/</a>.
// Also, you can try interactive lessons for GoLand by selecting 'Help | Learn IDE Features' from the main menu.
