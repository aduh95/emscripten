// ems_test.cpp
#include <exception>
#include <iostream>

struct Base
{
    virtual ~Base() {}
};

struct Exception: public Base, public std::exception
{
};

int main()
{
    try
    {
        throw Exception();
    }
    catch (const std::exception&)
    {
    }

    if (std::uncaught_exception())
    {
        std::cout << "!!! BAD !!!" << std::endl;
    }
    else
    {
        std::cout << "OK" << std::endl;
    }
}
