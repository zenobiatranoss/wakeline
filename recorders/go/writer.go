package main

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"
)

type writer struct {
	mu       sync.Mutex
	f        *os.File
	bw       *bufio.Writer
	outPath  string
	maxBytes int64
	bcount   int64
}

func newWriter(path string, maxBytes int64) (*writer, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}
	return &writer{
		f:        f,
		bw:       bufio.NewWriter(f),
		outPath:  path,
		maxBytes: maxBytes,
	}, nil
}

func (w *writer) write(obj map[string]interface{}, force bool) int64 {
	if w == nil {
		return 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.maxBytes > 0 && !force {
		if w.bcount > w.maxBytes {
			return -1
		}
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return 0
	}
	line := append(b, '\n')
	if w.maxBytes > 0 && !force {
		if w.bcount+int64(len(line)) > w.maxBytes {
			return -1
		}
	}
	if _, err := w.bw.Write(line); err != nil {
		return 0
	}
	w.bcount += int64(len(line))
	return int64(len(line))
}

func (w *writer) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.bw != nil {
		w.bw.Flush()
	}
	if w.f != nil {
		w.f.Sync()
	}
}

func (w *writer) close() {
	w.flush()
	if w.f != nil {
		w.f.Close()
	}
}

func (w *writer) bytes() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.bcount
}
