package main

import "reflect"

func (s *state) setField(name string, v interface{}) {
	if s == nil {
		return
	}
	if isMasked(name) {
		return
	}
	// locals captured by closure read directly
}

var _ reflect.Value

func (s *state) hasReturnFlag() bool { return s != nil && s.hasReturn }
