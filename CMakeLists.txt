cmake_minimum_required(VERSION 3.14)

project(WaveformViewer LANGUAGES CXX C)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG -flto")
set(CMAKE_CXX_FLAGS_DEBUG "-g -O0")

# --- nlohmann/json via FetchContent ---
include(FetchContent)
FetchContent_Declare(
    json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3
    GIT_SHALLOW    TRUE
)
set(JSON_BuildTests OFF CACHE INTERNAL "")
FetchContent_MakeAvailable(json)

if(EMSCRIPTEN)
    message(STATUS "Configuring for WebAssembly build with Emscripten")
    # =========================================================================
    # WASM build: vcd_parser.js + vcd_parser.wasm via Embind
    # =========================================================================
    add_executable(vcd_parser
        src/vcd_parser.cpp
        src/wasm_bindings.cpp
    )
    target_include_directories(vcd_parser PUBLIC include)
    target_link_libraries(vcd_parser PRIVATE nlohmann_json::nlohmann_json)

    # Embind + WASM flags
    target_link_options(vcd_parser PRIVATE
        --bind
        -sWASM=1
        -sWASM_BIGINT=1
        -sMODULARIZE=1
        -sEXPORT_NAME=createVcdParser
        -sALLOW_MEMORY_GROWTH=1
        -sMAXIMUM_MEMORY=2GB
        -sSTACK_SIZE=1MB
        -sINITIAL_MEMORY=16MB
        -sEXPORTED_RUNTIME_METHODS=['UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8','FS']
        -sENVIRONMENT=web,worker,node
        -sNO_EXIT_RUNTIME=1
        -sFORCE_FILESYSTEM=1
        -lworkerfs.js
        -lnodefs.js
        -sDISABLE_EXCEPTION_CATCHING=1
        -sDYNAMIC_EXECUTION=0
    )

    # Output to wasm/ directory
    set_target_properties(vcd_parser PROPERTIES
        OUTPUT_NAME "vcd_parser"
        SUFFIX ".js"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/wasm"
    )
else()
    # =========================================================================
    # Native build: static library + CLI viewer
    # =========================================================================
    message(STATUS "Configuring for native build")
    add_library(vcd_parser STATIC
        src/vcd_parser.cpp
    )
    target_include_directories(vcd_parser PUBLIC include)
    target_link_libraries(vcd_parser PRIVATE nlohmann_json::nlohmann_json)

    add_executable(vcd_viewer src/main.cpp)
    target_link_libraries(vcd_viewer PRIVATE vcd_parser)

    # =========================================================================
    # libfst integration
    # =========================================================================
    message(STATUS "Integrating libfst")

    find_package(ZLIB REQUIRED)
    find_package(BZip2 REQUIRED)
    find_package(Threads REQUIRED)

    include(CheckFunctionExists)
    check_function_exists(fseeko HAVE_FSEEKO)
    check_function_exists(realpath HAVE_REALPATH)

    # Generate config.h in the build directory
    set(FST_WRITER_PARALLEL ON)
    set(HAVE_LIBPTHREAD ON)

    file(WRITE "${CMAKE_BINARY_DIR}/libfst_config/config.h"
        "#ifndef FST_CONFIG_H\n"
        "#define FST_CONFIG_H\n\n"
        "#cmakedefine HAVE_FSEEKO 1\n"
        "#cmakedefine HAVE_REALPATH 1\n"
        "#define FST_WRITER_PARALLEL 1\n"
        "#define HAVE_LIBPTHREAD 1\n\n"
        "#endif\n"
    )
    # Actually, file(WRITE) doesn't do #cmakedefine expansion.
    # I'll use configure_file instead or just write the values directly since it's native build on linux.

    set(CONFIG_H_CONTENT "
#ifndef FST_CONFIG_H
#define FST_CONFIG_H

#define HAVE_FSEEKO 1
#define HAVE_REALPATH 1
#define FST_WRITER_PARALLEL 1
#define HAVE_LIBPTHREAD 1

#endif
")
    file(WRITE "${CMAKE_BINARY_DIR}/libfst-config/config.h" "${CONFIG_H_CONTENT}")

    add_library(fst STATIC
        libfst/src/fastlz.c
        libfst/src/fstapi.c
        libfst/src/lz4.c
    )

    target_include_directories(fst PUBLIC
        libfst/src
        ${CMAKE_BINARY_DIR}/libfst-config
    )

    target_compile_definitions(fst PRIVATE
        _GNU_SOURCE
        FST_INCLUDE_CONFIG
    )

    target_link_libraries(fst PRIVATE
        ZLIB::ZLIB
        BZip2::BZip2
        Threads::Threads
    )

    # Link vcd_viewer with fst
    target_link_libraries(vcd_viewer PRIVATE fst)
endif()

# Create a symbolink from build_dir/compile_commands.json to project root
file(CREATE_LINK "${CMAKE_BINARY_DIR}/compile_commands.json" "${CMAKE_SOURCE_DIR}/compile_commands.json" SYMBOLIC)
