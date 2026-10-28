package main

// go recorder cli. instruments the target function, copies the package to a
// temp dir, adds the runtime, builds, and runs. never breaks the user's program.

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func main() {
	setOptions()
	args := os.Args[1:]
	var file, name, lines, out, mask string
	var maxCalls, maxEvents, maxBytes int64 = 100, 10000, 0
	var rest []string
	extra := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if extra {
			rest = append(rest, a)
			continue
		}
		if a == "--" {
			extra = true
			continue
		}
		if strings.HasPrefix(a, "--") {
			key := strings.TrimPrefix(a, "--")
			if i+1 >= len(args) {
				fmt.Fprintf(os.Stderr, "wakeline: %s needs a value\n", a)
				os.Exit(2)
			}
			val := args[i+1]
			i++
			switch key {
			case "file":
				file = val
			case "name":
				name = val
			case "lines":
				lines = val
			case "out":
				out = val
			case "max-calls":
				maxCalls, _ = strconv.ParseInt(val, 10, 64)
			case "max-events":
				maxEvents, _ = strconv.ParseInt(val, 10, 64)
			case "max-bytes":
				maxBytes, _ = strconv.ParseInt(val, 10, 64)
			case "mask":
				mask = val
			}
			continue
		}
		rest = append(rest, a)
	}

	// set env for runtime
	os.Setenv("wakeline_file", file)
	os.Setenv("wakeline_out", out)
	os.Setenv("wakeline_name", name)
	if lines != "" {
		parts := strings.Split(lines, ":")
		if len(parts) == 2 {
			os.Setenv("wakeline_line0", parts[0])
			os.Setenv("wakeline_line1", parts[1])
		}
	}
	os.Setenv("wakeline_max_calls", fmt.Sprintf("%d", maxCalls))
	os.Setenv("wakeline_max_events", fmt.Sprintf("%d", maxEvents))
	os.Setenv("wakeline_max_bytes", fmt.Sprintf("%d", maxBytes))
	os.Setenv("wakeline_mask", mask)

	setOptions()

	if file == "" || out == "" {
		fmt.Fprintln(os.Stderr, "wakeline: --file and --out are required")
		os.Exit(2)
	}
	abs, err := filepath.Abs(file)
	if err != nil {
		fail("bad path", 2)
	}
	if _, err := os.Stat(abs); err != nil {
		fail(fmt.Sprintf("program not found: %s", abs), 2)
	}

	// copy package to temp dir
	dir := filepath.Dir(abs)
	tmp, err := ioutil.TempDir("", "wakeline_go_")
	if err != nil {
		fail("cannot make temp dir", 2)
	}
	defer os.RemoveAll(tmp)

	// copy all .go files
	entries, err := ioutil.ReadDir(dir)
	if err != nil {
		fail("cannot read dir", 2)
	}
	hasMain := false
	var origPkg string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		src := filepath.Join(dir, e.Name())
		dst := filepath.Join(tmp, e.Name())
		b, err := ioutil.ReadFile(src)
		if err != nil {
			continue
		}
		sbody := string(b)
		if strings.Contains(sbody, "func main()") {
			hasMain = true
		}
		// sniff package
		for _, ln := range strings.Split(sbody, "\n") {
			ln = strings.TrimSpace(ln)
			if strings.HasPrefix(ln, "//") {
				continue
			}
			if strings.HasPrefix(ln, "package ") {
				origPkg = strings.TrimSpace(strings.TrimPrefix(ln, "package "))
				break
			}
		}
		if filepath.Clean(src) == filepath.Clean(abs) {
			// instrument this file
			var line0, line1 int
			if lines != "" {
				p := strings.Split(lines, ":")
				if len(p) == 2 {
					line0, _ = strconv.Atoi(p[0])
					line1, _ = strconv.Atoi(p[1])
				}
			}
			b2, err2 := instrumentSource(b, target{name: name, line0: line0, line1: line1, file: abs})
			if err2 != nil {
				fmt.Fprintf(os.Stderr, "wakeline: instrumentation failed: %s, running without tracing\n", err2)
				failure("instrument", err2.Error())
			} else {
				b = b2
			}
		}
		if err := ioutil.WriteFile(dst, b, 0644); err != nil {
			fail("cannot write temp file", 2)
		}
	}
	if !hasMain {
		if origPkg == "" || origPkg == "main" {
			dummy := []byte("package main\n\nfunc main() {}\n")
			ioutil.WriteFile(filepath.Join(tmp, "wakeline_dummy_main.go"), dummy, 0644)
		} else {
			// library package - convert to main package
			entries2, _ := ioutil.ReadDir(tmp)
			for _, e := range entries2 {
				if e.IsDir() {
					continue
				}
				if !strings.HasSuffix(e.Name(), ".go") {
					continue
				}
				p := filepath.Join(tmp, e.Name())
				b, err := ioutil.ReadFile(p)
				if err != nil {
					continue
				}
				bs := string(b)
				// replace package declaration
				lines2 := strings.Split(bs, "\n")
				for i := range lines2 {
					lt := strings.TrimSpace(lines2[i])
					if strings.HasPrefix(lt, "//") {
						continue
					}
					if strings.HasPrefix(lt, "package ") {
						lines2[i] = "package main"
						break
					}
				}
				ioutil.WriteFile(p, []byte(strings.Join(lines2, "\n")), 0644)
			}
			dummy := []byte("package main\n\nfunc main() {}\n")
			ioutil.WriteFile(filepath.Join(tmp, "wakeline_dummy_main2.go"), dummy, 0644)
		}
	}

	// copy runtime files
	for _, rf := range []string{"runtime.go", "writer.go", "encode.go", "state_extra.go"} {
		rp := filepath.Join(filepath.Dir(os.Args[0]), rf)
		if _, err := os.Stat(rp); err != nil {
			// also look next to this file
			rp = filepath.Join("/home/ollama/Desktop/wakeline/recorders/go", rf)
		}
		b, err := ioutil.ReadFile(rp)
		if err != nil {
			continue
		}
		if err := ioutil.WriteFile(filepath.Join(tmp, rf), b, 0644); err != nil {
			continue
		}
	}

	// write initial headers
	if out != "" {
		_ = os.MkdirAll(filepath.Dir(out), 0755)
		if f, err := os.Create(out); err == nil {
			f.WriteString("{\"k\":\"ver\",\"v\":1}\n")
			f.WriteString("{\"k\":\"meta\",\"src\":" + strconvQuote(abs) + "}\n")
			f.Close()
		}
	}
	// ensure module
	if _, err := os.Stat(filepath.Join(tmp, "go.mod")); os.IsNotExist(err) {
		initm := exec.Command("go", "mod", "init", "wakelinetmp")
		initm.Dir = tmp
		initm.Env = append(os.Environ(), "GO111MODULE=on")
		initm.Run()
	}
	// build
	build := exec.Command("go", "build", "-o", filepath.Join(tmp, "prog"), ".")
	build.Dir = tmp
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	build.Env = append(os.Environ(), "GO111MODULE=on")
	if err := build.Run(); err != nil {
		msg := err.Error()
		fail(fmt.Sprintf("go build failed: %s", msg), 2)
		return
	}

	// run
	prog := exec.Command(filepath.Join(tmp, "prog"), rest...)
	prog.Stdin = os.Stdin
	prog.Stdout = os.Stdout
	prog.Stderr = os.Stderr
	prog.Env = os.Environ()
	err = prog.Run()
	if w != nil {
		w.flush()
		w.close()
	}
	if err != nil {
		// program exited nonzero - that's fine, recording may have it
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		os.Exit(1)
	}
	os.Exit(0)
}

func fail(msg string, code int) {
	fmt.Fprintf(os.Stderr, "wakeline: %s\n", msg)
	tryWriteFailure(os.Getenv("wakeline_out"), msg)
	os.Exit(code)
}

func strconvQuote(s string) string { b,_ := json.Marshal(s); return string(b) }

func tryWriteFailure(out, msg string) {
	if out == "" {
		return
	}
	os.MkdirAll(filepath.Dir(out), 0755)
	lines := []string{
		jsonString(map[string]interface{}{"k": "ver", "v": 1}),
		jsonString(map[string]interface{}{"k": "failure", "why": msg, "where": "start"}),
	}
	f, err := os.Create(out)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(strings.Join(lines, "\n") + "\n")
}

func jsonString(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}
