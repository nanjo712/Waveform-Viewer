cmake_minimum_required(VERSION 3.14)

project(WaveformViewer LANGUAGES CXX)

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
        -sEXPORTED_RUNTIME_METHODS=['UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8']
        -sENVIRONMENT=web,worker,node
        -sNO_EXIT_RUNTIME=1
        -sFILESYSTEM=0
        -sDISABLE_EXCEPTION_CATCHING=1
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
endif()
