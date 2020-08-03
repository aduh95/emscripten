/**
 * @license
 * Copyright 2010 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

var LibraryExceptions = {
  $exceptionLast: '0',
  $exceptionCaught: ' []',
  $exceptionInfos: '{}',

  $exception_deAdjust__deps: ['$exceptionInfos'],
  $exception_deAdjust: function(adjusted) {
    if (!adjusted || exceptionInfos[adjusted]) return adjusted;
    for (var key in exceptionInfos) {
      var ptr = +key; // the iteration key is a string, and if we throw this, it must be an integer as that is what we look for
      var adj = exceptionInfos[ptr].adjusted;
      var len = adj.length;
      for (var i = 0; i < len; i++) {
        if (adj[i] === adjusted) {
#if EXCEPTION_DEBUG
          err('de-adjusted exception ptr ' + adjusted + ' to ' + ptr);
#endif
          return ptr;
        }
      }
    }
#if EXCEPTION_DEBUG
    err('no de-adjustment for unknown exception ptr ' + adjusted);
#endif
    return adjusted;
  },

  $exception_addRef__deps: ['$exceptionInfos'],
  $exception_addRef: function(ptr) {
#if EXCEPTION_DEBUG
    err('addref ' + ptr);
#endif
    if (!ptr) return;
    var info = exceptionInfos[ptr];
    info.refcount++;
  },

  $exception_decRef__deps: ['$exceptionInfos', '__cxa_free_exception'
#if EXCEPTION_DEBUG
      , '$exceptionLast', '$exceptionCaught'
#endif
    ],
  $exception_decRef: function(ptr) {
#if EXCEPTION_DEBUG
    err('decref ' + ptr);
#endif
    if (!ptr) return;
    var info = exceptionInfos[ptr];
#if ASSERTIONS
    assert(info.refcount > 0);
#endif
    info.refcount--;
    // A rethrown exception can reach refcount 0; it must not be discarded
    // Its next handler will clear the rethrown flag and addRef it, prior to
    // final decRef and destruction here
    if (info.refcount === 0 && !info.rethrown) {
      if (info.destructor) {
#if WASM_BACKEND == 0
        Module['dynCall_vi'](info.destructor, ptr);
#else
        // In Wasm, destructors return 'this' as in ARM
        Module['dynCall_ii'](info.destructor, ptr);
#endif
      }
      delete exceptionInfos[ptr];
      ___cxa_free_exception(ptr);
#if EXCEPTION_DEBUG
      err('decref freeing exception ' + [ptr, exceptionLast, 'stack', exceptionCaught]);
#endif
    }
  },

  // Exceptions
  __cxa_allocate_exception: function(size) {
    return _malloc(size);
  },

  __cxa_free_exception: function(ptr) {
#if ABORTING_MALLOC || ASSERTIONS
    try {
#endif
      return _free(ptr);
#if ABORTING_MALLOC || ASSERTIONS
    } catch(e) {
#if ASSERTIONS
      err('exception during cxa_free_exception: ' + e);
#endif
    }
#endif
  },

  __cxa_increment_exception_refcount__deps: ['$exception_addRef', '$exception_deAdjust'],
  __cxa_increment_exception_refcount: function(ptr) {
    exception_addRef(exception_deAdjust(ptr));
  },

  __cxa_decrement_exception_refcount__deps: ['$exception_decRef', '$exception_deAdjust'],
  __cxa_decrement_exception_refcount: function(ptr) {
    exception_decRef(exception_deAdjust(ptr));
  },

  // Here, we throw an exception after recording a couple of values that we need to remember
  // We also remember that it was the last exception thrown as we need to know that later.
  __cxa_throw__sig: 'viii',
  __cxa_throw__deps: ['$exceptionInfos', '$exceptionLast', '_ZSt18uncaught_exceptionv'],
  __cxa_throw: function(ptr, type, destructor) {
#if EXCEPTION_DEBUG
    err('Compiled code throwing an exception, ' + [ptr,type,destructor]);
#endif
    exceptionInfos[ptr] = {
      ptr: ptr,
      adjusted: [ptr],
      type: type,
      destructor: destructor,
      refcount: 0,
      caught: false,
      rethrown: false
    };
    exceptionLast = ptr;
    if (!("uncaught_exception" in __ZSt18uncaught_exceptionv)) {
      __ZSt18uncaught_exceptionv.uncaught_exceptions = 1;
    } else {
      __ZSt18uncaught_exceptionv.uncaught_exceptions++;
    }
    {{{ makeThrow('ptr') }}}
  },

  // This exception will be caught twice, but while begin_catch runs twice,
  // we early-exit from end_catch when the exception has been rethrown, so
  // pop that here from the caught exceptions.
  __cxa_rethrow__deps: ['$exceptionCaught', '$exception_deAdjust', '$exceptionInfos', '$exceptionLast'],
  __cxa_rethrow: function() {
    var ptr = exceptionCaught.pop();
    ptr = exception_deAdjust(ptr);
    if (!exceptionInfos[ptr].rethrown) {
      // Only pop if the corresponding push was through rethrow_primary_exception
      exceptionCaught.push(ptr);
      exceptionInfos[ptr].rethrown = true;
    }
#if EXCEPTION_DEBUG
    err('Compiled code RE-throwing an exception, popped ' + [ptr, exceptionLast, 'stack', exceptionCaught]);
#endif
    exceptionLast = ptr;
    {{{ makeThrow('ptr') }}}
  },

  llvm_eh_exception__deps: ['$exceptionLast'],
  llvm_eh_exception: function() {
    return exceptionLast;
  },

  llvm_eh_selector__jsargs: true,
  llvm_eh_selector__deps: ['$exceptionLast'],
  llvm_eh_selector: function(unused_exception_value, personality/*, varargs*/) {
    var type = exceptionLast;
    for (var i = 2; i < arguments.length; i++) {
      if (arguments[i] ==  type) return type;
    }
    return 0;
  },

  llvm_eh_typeid_for: function(type) {
    return type;
  },

  __cxa_begin_catch__deps: ['$exceptionInfos', '$exceptionCaught', '$exception_addRef', '$exception_deAdjust', '_ZSt18uncaught_exceptionv'],
  __cxa_begin_catch: function(ptr) {
    ptr = exception_deAdjust(ptr);
    var info = exceptionInfos[ptr];
    if (info && !info.caught) {
      info.caught = true;
      __ZSt18uncaught_exceptionv.uncaught_exceptions--;
    }
    if (info) info.rethrown = false;
    exceptionCaught.push(ptr);
#if EXCEPTION_DEBUG
    err('cxa_begin_catch ' + [ptr, 'stack', exceptionCaught]);
#endif
    exception_addRef(ptr);
    return ptr;
  },

  // We're done with a catch. Now, we can run the destructor if there is one
  // and free the exception. Note that if the dynCall on the destructor fails
  // due to calling apply on undefined, that means that the destructor is
  // an invalid index into the FUNCTION_TABLE, so something has gone wrong.
  __cxa_end_catch__deps: ['$exceptionCaught', '$exceptionLast', '$exception_decRef', '$exception_deAdjust'
#if WASM_BACKEND == 0
  , 'setThrew'
#endif
  ],
  __cxa_end_catch: function() {
    // Clear state flag.
    _setThrew(0);
    // Call destructor if one is registered then clear it.
    var ptr = exceptionCaught.pop();
#if EXCEPTION_DEBUG
    err('cxa_end_catch popped ' + [ptr, exceptionLast, 'stack', exceptionCaught]);
#endif
    if (ptr) {
      exception_decRef(exception_deAdjust(ptr));
      exceptionLast = 0; // XXX in decRef?
    }
  },
  __cxa_get_exception_ptr: function(ptr) {
#if EXCEPTION_DEBUG
    err('cxa_get_exception_ptr ' + ptr);
#endif
    // TODO: use info.adjusted?
    return ptr;
  },

  _ZSt18uncaught_exceptionv: function() { // std::uncaught_exception()
    return __ZSt18uncaught_exceptionv.uncaught_exceptions > 0;
  },

  __cxa_uncaught_exceptions__deps: ['_ZSt18uncaught_exceptionv'],
  __cxa_uncaught_exceptions: function() {
    return __ZSt18uncaught_exceptionv.uncaught_exceptions;
  },

  __cxa_call_unexpected: function(exception) {
    err('Unexpected exception thrown, this is not properly supported - aborting');
#if !MINIMAL_RUNTIME
    ABORT = true;
#endif
    throw exception;
  },

  __cxa_current_primary_exception__deps: ['$exceptionCaught', '$exception_addRef', '$exception_deAdjust'],
  __cxa_current_primary_exception: function() {
    var ret = exceptionCaught[exceptionCaught.length-1] || 0;
    if (ret) exception_addRef(exception_deAdjust(ret));
    return ret;
  },

  __cxa_rethrow_primary_exception__deps: ['$exception_deAdjust', '$exceptionCaught', '$exceptionInfos', '__cxa_rethrow'],
  __cxa_rethrow_primary_exception: function(ptr) {
    if (!ptr) return;
    ptr = exception_deAdjust(ptr);
    exceptionCaught.push(ptr);
    exceptionInfos[ptr].rethrown = true;
    ___cxa_rethrow();
  },

  // Finds a suitable catch clause for when an exception is thrown.
  // In normal compilers, this functionality is handled by the C++
  // 'personality' routine. This is passed a fairly complex structure
  // relating to the context of the exception and makes judgements
  // about how to handle it. Some of it is about matching a suitable
  // catch clause, and some of it is about unwinding. We already handle
  // unwinding using 'if' blocks around each function, so the remaining
  // functionality boils down to picking a suitable 'catch' block.
  // We'll do that here, instead, to keep things simpler.

  __cxa_find_matching_catch__deps: ['$exceptionLast', '$exceptionInfos', '__resumeException'],
  __cxa_find_matching_catch: function() {
    var thrown = exceptionLast;
    if (!thrown) {
      // just pass through the null ptr
      {{{ makeStructuralReturn([0, 0]) }}};
    }
    var info = exceptionInfos[thrown];
    var throwntype = info.type;
    if (!throwntype) {
      // just pass through the thrown ptr
      {{{ makeStructuralReturn(['thrown', 0]) }}};
    }
    var typeArray = Array.prototype.slice.call(arguments);

    var pointer = {{{ exportedAsmFunc('___cxa_is_pointer_type') }}}(throwntype);
    // can_catch receives a **, add indirection
#if EXCEPTION_DEBUG
    out("can_catch on " + [thrown]);
#endif
#if DISABLE_EXCEPTION_CATCHING == 1
    var buffer = 0;
#else
    var buffer = {{{ makeStaticAlloc(4) }}};
#endif
    {{{ makeSetValue('buffer', '0', 'thrown', '*') }}};
    thrown = buffer;
    // The different catch blocks are denoted by different types.
    // Due to inheritance, those types may not precisely match the
    // type of the thrown object. Find one which matches, and
    // return the type of the catch block which should be called.
    for (var i = 0; i < typeArray.length; i++) {
      if (typeArray[i] && {{{ exportedAsmFunc('___cxa_can_catch') }}}(typeArray[i], throwntype, thrown)) {
        thrown = {{{ makeGetValue('thrown', '0', '*') }}}; // undo indirection
        info.adjusted.push(thrown);
#if EXCEPTION_DEBUG
        out("  can_catch found " + [thrown, typeArray[i]]);
#endif
        {{{ makeStructuralReturn(['thrown', 'typeArray[i]']) }}};
      }
    }
    // Shouldn't happen unless we have bogus data in typeArray
    // or encounter a type for which emscripten doesn't have suitable
    // typeinfo defined. Best-efforts match just in case.
    thrown = {{{ makeGetValue('thrown', '0', '*') }}}; // undo indirection
    {{{ makeStructuralReturn(['thrown', 'throwntype']) }}};
  },

  __resumeException__deps: [function() { '$exceptionLast', Functions.libraryFunctions['___resumeException'] = 1 }], // will be called directly from compiled code
  __resumeException: function(ptr) {
#if EXCEPTION_DEBUG
    out("Resuming exception " + [ptr, exceptionLast]);
#endif
    if (!exceptionLast) { exceptionLast = ptr; }
    {{{ makeThrow('ptr') }}}
  },
};

// In LLVM, exceptions generate a set of functions of form __cxa_find_matching_catch_1(), __cxa_find_matching_catch_2(), etc.
// where the number specifies the number of arguments. In Emscripten, route all these to a single function '__cxa_find_matching_catch'
// that variadically processes all of these functions using JS 'arguments' object.
addCxaCatch = function(n) {
  LibraryManager.library['__cxa_find_matching_catch_' + n] = LibraryExceptions['__cxa_find_matching_catch'];
  LibraryManager.library['__cxa_find_matching_catch_' + n + '__sig'] = new Array(n + 2).join('i');
};

mergeInto(LibraryManager.library, LibraryExceptions);
