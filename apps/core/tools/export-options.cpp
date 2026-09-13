// Export the actual option metadata from the repository's pinned llama.cpp.
#include "arg.h"
#include "common.h"
#include "json.hpp"
#include <iostream>
#include <string>

int main() {
    common_params params;
    auto context = common_params_parser_init(params, LLAMA_EXAMPLE_SERVER);
    common_params_add_preset_options(context.options);
    nlohmann::ordered_json result;
    auto key=[](std::string s){return s.substr(s.find_first_not_of('-'));};
    for (const auto & option : context.options) {
        if (option.args.empty()) continue;
        auto canonical=key(option.args.back());
        auto add=[&](const std::string & alias,bool negated){
            result[alias]={{"canonical",canonical},{"negated",negated},{"kind",option.handler_int ? "integer" : option.handler_bool ? "boolean" : option.handler_void ? "flag" : option.value_hint_2 ? "two_values" : "string"}};
        };
        for (const auto & alias : option.args) add(key(alias),false);
        for (const auto & alias : option.args_neg) add(key(alias),true);
        for (const auto & alias : option.get_env()) add(alias,false);
    }
    std::cout << result.dump(2) << '\n';
}
